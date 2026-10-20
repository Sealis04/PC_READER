import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { customFields, deviceFieldHistory, deviceFieldValues, devices, secretAccessLog, type CustomField, type SecretAccessLogRow } from "@/db/schema";
import { verifyPin, type PinMethod, type VerifyResult } from "@/lib/it-pin";
import { decryptSecret, encryptSecret, secretsDisabledReason, SecretsDecryptError } from "@/lib/secrets-crypto";

export const MAX_FIELD_NAME_LENGTH = 100;
export const MAX_TEXT_VALUE_LENGTH = 500;
export const MAX_SECRET_LENGTH = 1000;
export const FIELD_TYPES = ["text", "date", "secret"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];
export const isFieldType = (v: unknown): v is FieldType => typeof v === "string" && (FIELD_TYPES as readonly string[]).includes(v);

export class FieldError extends Error {
  constructor(
    public readonly status: 400 | 404 | 409 | 503,
    public readonly code: "invalid_payload" | "not_found" | "conflict" | "secrets_unavailable",
    message: string,
  ) {
    super(message);
  }
}

// A PIN check that did not pass (wrong PIN or rate limited); the handler maps it with pinErrorResponse.
export class PinRefused extends Error {
  constructor(public readonly result: Exclude<VerifyResult, "ok">) {
    super(result);
  }
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export async function listFields(db: Db, opts: { includeArchived?: boolean } = {}): Promise<CustomField[]> {
  return db
    .select()
    .from(customFields)
    .where(opts.includeArchived ? undefined : isNull(customFields.archivedAt))
    .orderBy(asc(customFields.position), asc(customFields.createdAt));
}

function cleanName(name: unknown): string {
  if (typeof name !== "string" || !name.trim()) throw new FieldError(400, "invalid_payload", "The field name cannot be empty");
  const n = name.trim();
  if (n.length > MAX_FIELD_NAME_LENGTH) throw new FieldError(400, "invalid_payload", `The field name must be at most ${MAX_FIELD_NAME_LENGTH} characters`);
  return n;
}

async function assertNameFree(tx: Db | Tx, name: string, exceptId?: string): Promise<void> {
  const rows = await tx.select({ id: customFields.id }).from(customFields).where(sql`lower(${customFields.name}) = lower(${name})`);
  if (rows.some((r) => r.id !== exceptId)) throw new FieldError(409, "conflict", `A field named "${name}" already exists`);
}

export async function createField(db: Db, input: { name: unknown; type: unknown }): Promise<CustomField> {
  const name = cleanName(input.name);
  if (!isFieldType(input.type)) throw new FieldError(400, "invalid_payload", `type must be one of ${FIELD_TYPES.join(", ")}`);
  const type = input.type;
  return db.transaction(async (tx) => {
    // Serialises concurrent creates so positions and the name check do not race.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('custom_fields'))`);
    await assertNameFree(tx, name);
    const [{ next }] = await tx.select({ next: sql<number>`coalesce(max(${customFields.position}), -1) + 1` }).from(customFields);
    const [row] = await tx.insert(customFields).values({ name, type, position: Number(next) }).returning();
    return row;
  });
}

// Renames and/or archives (archived = true) or restores (false) a field. The type never changes.
export async function updateField(db: Db, id: string, input: { name?: unknown; archived?: unknown }): Promise<CustomField> {
  if (input.archived !== undefined && typeof input.archived !== "boolean") throw new FieldError(400, "invalid_payload", "archived must be true or false");
  if (input.name === undefined && input.archived === undefined) throw new FieldError(400, "invalid_payload", "Nothing to change");
  const name = input.name === undefined ? undefined : cleanName(input.name);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('custom_fields'))`);
    const [field] = await tx.select().from(customFields).where(eq(customFields.id, id)).for("update");
    if (!field) throw new FieldError(404, "not_found", "No such field");
    if (name !== undefined) await assertNameFree(tx, name, id);
    const [row] = await tx
      .update(customFields)
      .set({
        ...(name !== undefined && { name }),
        ...(input.archived !== undefined && { archivedAt: input.archived ? (field.archivedAt ?? new Date()) : null }),
      })
      .where(eq(customFields.id, id))
      .returning();
    return row;
  });
}

// Sets the display order to the given list of field ids (all active fields must be listed).
export async function reorderFields(db: Db, ids: unknown): Promise<void> {
  if (!Array.isArray(ids) || ids.some((i) => typeof i !== "string")) throw new FieldError(400, "invalid_payload", "ids must be a list of field ids");
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('custom_fields'))`);
    const active = await tx.select({ id: customFields.id }).from(customFields).where(isNull(customFields.archivedAt));
    const given = new Set(ids as string[]);
    if (given.size !== ids.length || given.size !== active.length || active.some((f) => !given.has(f.id))) {
      throw new FieldError(400, "invalid_payload", "ids must list every active field exactly once");
    }
    for (const [position, id] of (ids as string[]).entries()) await tx.update(customFields).set({ position }).where(eq(customFields.id, id));
  });
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
export function isValidDate(v: string): boolean {
  const m = DATE_RE.exec(v);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

async function lockDevice(tx: Tx, id: string): Promise<void> {
  const [device] = await tx.select({ id: devices.id }).from(devices).where(eq(devices.id, id)).for("update");
  if (!device) throw new FieldError(404, "not_found", "No such device");
}

async function loadField(tx: Db | Tx, id: string): Promise<CustomField> {
  const [field] = await tx.select().from(customFields).where(eq(customFields.id, id));
  if (!field) throw new FieldError(404, "not_found", "No such field");
  return field;
}

// Sets (or, with null / an empty string, clears) a text or date value and records the old and new
// value in the device history. Secrets go through setSecret instead.
export async function setFieldValue(db: Db, deviceId: string, fieldId: string, value: string | null, reason?: string | null): Promise<{ changed: boolean }> {
  if (value !== null && typeof value !== "string") throw new FieldError(400, "invalid_payload", "value must be a string or null");
  const clean = value?.trim() || null;
  return db.transaction(async (tx) => {
    await lockDevice(tx, deviceId);
    const field = await loadField(tx, fieldId);
    if (field.type === "secret") throw new FieldError(400, "invalid_payload", "Secret fields are changed with the IT PIN, not here");
    if (field.archivedAt) throw new FieldError(409, "conflict", "This field is archived");
    if (clean !== null) {
      if (field.type === "date" && !isValidDate(clean)) throw new FieldError(400, "invalid_payload", "The date must be written as YYYY-MM-DD");
      if (field.type === "text" && clean.length > MAX_TEXT_VALUE_LENGTH) throw new FieldError(400, "invalid_payload", `The value must be at most ${MAX_TEXT_VALUE_LENGTH} characters`);
    }
    const [current] = await tx
      .select()
      .from(deviceFieldValues)
      .where(and(eq(deviceFieldValues.deviceId, deviceId), eq(deviceFieldValues.fieldId, fieldId)));
    const old = (field.type === "date" ? current?.dateValue : current?.textValue) ?? null;
    if (old === clean) return { changed: false };
    const column = field.type === "date" ? { dateValue: clean } : { textValue: clean };
    await tx
      .insert(deviceFieldValues)
      .values({ deviceId, fieldId, ...column })
      .onConflictDoUpdate({ target: [deviceFieldValues.deviceId, deviceFieldValues.fieldId], set: { ...column, updatedAt: new Date() } });
    await tx.insert(deviceFieldHistory).values({ deviceId, field: "custom_field", customFieldId: fieldId, oldValue: old, newValue: clean, reason: reason?.trim().slice(0, 500) || null });
    return { changed: true };
  });
}

export interface DeviceFieldRow {
  field: CustomField;
  text: string | null;
  date: string | null;
  // Secrets: only whether a value exists, never the value or ciphertext.
  hasSecret: boolean;
  updatedAt: Date | null;
}

// The active fields with this device's values (archived fields are hidden; their values are kept).
export async function getDeviceFields(db: Db, deviceId: string): Promise<DeviceFieldRow[]> {
  const rows = await db
    .select({
      field: customFields,
      text: deviceFieldValues.textValue,
      date: deviceFieldValues.dateValue,
      hasSecret: sql<boolean>`${deviceFieldValues.secretCiphertext} is not null`,
      updatedAt: deviceFieldValues.updatedAt,
    })
    .from(customFields)
    .leftJoin(deviceFieldValues, and(eq(deviceFieldValues.fieldId, customFields.id), eq(deviceFieldValues.deviceId, deviceId)))
    .where(isNull(customFields.archivedAt))
    .orderBy(asc(customFields.position), asc(customFields.createdAt));
  return rows.map((r) => ({ field: r.field, text: r.text, date: r.date, hasSecret: Boolean(r.hasSecret), updatedAt: r.updatedAt }));
}

const SECRET_LOG_LIMIT = 20;

export async function getSecretAccessLog(db: Db, deviceId: string): Promise<Array<SecretAccessLogRow & { fieldName: string }>> {
  const rows = await db
    .select({ row: secretAccessLog, fieldName: customFields.name })
    .from(secretAccessLog)
    .innerJoin(customFields, eq(customFields.id, secretAccessLog.fieldId))
    .where(eq(secretAccessLog.deviceId, deviceId))
    .orderBy(desc(secretAccessLog.accessedAt))
    .limit(SECRET_LOG_LIMIT);
  return rows.map((r) => ({ ...r.row, fieldName: r.fieldName }));
}

const contextOf = (deviceId: string, fieldId: string) => `${deviceId}:${fieldId}`;

// Shared by reveal and set: the checks that do not depend on the PIN, then the PIN itself. Every
// outcome is logged (never the value); a wrong PIN or rate limit throws PinRefused.
async function authorizeSecret(db: Db, deviceId: string, fieldId: string, pin: unknown, action: SecretAccessLogRow["action"], method: PinMethod, clientIp: string | null): Promise<CustomField> {
  const unavailable = secretsDisabledReason();
  if (unavailable) throw new FieldError(503, "secrets_unavailable", unavailable);
  const [device] = await db.select({ id: devices.id }).from(devices).where(eq(devices.id, deviceId));
  if (!device) throw new FieldError(404, "not_found", "No such device");
  const field = await loadField(db, fieldId);
  if (field.type !== "secret") throw new FieldError(400, "invalid_payload", "This is not a secret field");
  const log = (success: boolean) => db.insert(secretAccessLog).values({ deviceId, fieldId, action, success, clientIp });
  if (typeof pin !== "string" || !pin) {
    await log(false);
    throw new PinRefused("wrong_pin");
  }
  const result = await verifyPin(db, deviceId, pin, method);
  if (result !== "ok") {
    await log(false);
    throw new PinRefused(result);
  }
  return field;
}

// Sets (or, with null, clears) a device's secret. Needs the current IT PIN; the history row says only
// that it changed.
export async function setSecret(db: Db, deviceId: string, fieldId: string, value: string | null, pin: unknown, clientIp: string | null = null): Promise<{ changed: true }> {
  if (value !== null && typeof value !== "string") throw new FieldError(400, "invalid_payload", "value must be a string or null");
  if (value !== null && value.length > MAX_SECRET_LENGTH) throw new FieldError(400, "invalid_payload", `The secret must be at most ${MAX_SECRET_LENGTH} characters`);
  const clear = value === null || value === "";
  const field = await authorizeSecret(db, deviceId, fieldId, pin, clear ? "clear" : "set", "set_secret", clientIp);
  if (field.archivedAt) throw new FieldError(409, "conflict", "This field is archived");
  await db.transaction(async (tx) => {
    await lockDevice(tx, deviceId);
    const enc = clear ? null : encryptSecret(value as string, contextOf(deviceId, fieldId));
    const columns = { secretCiphertext: enc?.ciphertext ?? null, secretNonce: enc?.nonce ?? null };
    await tx
      .insert(deviceFieldValues)
      .values({ deviceId, fieldId, ...columns })
      .onConflictDoUpdate({ target: [deviceFieldValues.deviceId, deviceFieldValues.fieldId], set: { ...columns, updatedAt: new Date() } });
    await tx.insert(deviceFieldHistory).values({ deviceId, field: "custom_field", customFieldId: fieldId, reason: clear ? "Secret cleared" : "Secret changed" });
    await tx.insert(secretAccessLog).values({ deviceId, fieldId, action: clear ? "clear" : "set", success: true, clientIp });
  });
  return { changed: true };
}

// The only code path that returns a secret's plain value. Needs the current IT PIN and is logged.
export async function revealSecret(db: Db, deviceId: string, fieldId: string, pin: unknown, clientIp: string | null = null): Promise<{ value: string }> {
  await authorizeSecret(db, deviceId, fieldId, pin, "reveal", "reveal_secret", clientIp);
  const [row] = await db
    .select()
    .from(deviceFieldValues)
    .where(and(eq(deviceFieldValues.deviceId, deviceId), eq(deviceFieldValues.fieldId, fieldId)));
  if (!row?.secretCiphertext || !row.secretNonce) throw new FieldError(404, "not_found", "This secret has no value");
  let value: string;
  try {
    value = decryptSecret(row.secretCiphertext, row.secretNonce, contextOf(deviceId, fieldId));
  } catch (e) {
    if (e instanceof SecretsDecryptError) throw new FieldError(503, "secrets_unavailable", e.message);
    throw e;
  }
  await db.insert(secretAccessLog).values({ deviceId, fieldId, action: "reveal", success: true, clientIp });
  return { value };
}
