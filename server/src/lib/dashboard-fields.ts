import type { Db } from "@/db";
import type { CustomField } from "@/db/schema";
import { createField, FieldError, getDeviceFields, listFields, PinRefused, reorderFields, revealSecret, setFieldValue, setSecret, updateField } from "@/lib/custom-fields";
import { HttpError, errorResponse, jsonResponse, readJson } from "@/lib/http";
import { clientIp, pinErrorResponse } from "@/lib/it-pin";
import { secretsDisabledReason } from "@/lib/secrets-crypto";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const fieldJson = (f: CustomField) => ({
  id: f.id,
  name: f.name,
  type: f.type,
  position: f.position,
  archived: f.archivedAt !== null,
  created_at: f.createdAt.toISOString(),
});

async function body(req: Request): Promise<Record<string, unknown> | Response> {
  try {
    const b = await readJson(req);
    return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
  } catch (e) {
    if (e instanceof HttpError) return e.response;
    throw e;
  }
}

// Maps the domain errors to the JSON error responses; anything else is a bug and propagates.
async function guard(run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof FieldError) return errorResponse(e.status, e.code, e.message);
    if (e instanceof PinRefused) return pinErrorResponse(e.result)!;
    throw e;
  }
}

const badId = () => errorResponse(404, "not_found", "No such device or field");

// GET /api/dashboard/fields?archived=1 — the field definitions (no values).
export async function handleListFields(db: Db, includeArchived = false): Promise<Response> {
  const fields = await listFields(db, { includeArchived });
  const reason = secretsDisabledReason();
  return jsonResponse({ secrets_enabled: reason === null, secrets_disabled_reason: reason, fields: fields.map(fieldJson) });
}

// POST /api/dashboard/fields { name, type: "text" | "date" | "secret" } → 201.
export async function handleCreateField(req: Request, db: Db): Promise<Response> {
  const b = await body(req);
  if (b instanceof Response) return b;
  return guard(async () => jsonResponse(fieldJson(await createField(db, { name: b.name, type: b.type })), 201));
}

// PATCH /api/dashboard/fields/{id} { name?, archived? }
export async function handleUpdateField(req: Request, db: Db, id: string): Promise<Response> {
  const b = await body(req);
  if (b instanceof Response) return b;
  if (!UUID_RE.test(id)) return errorResponse(404, "not_found", "No such field");
  return guard(async () => jsonResponse(fieldJson(await updateField(db, id, { name: b.name, archived: b.archived }))));
}

// POST /api/dashboard/fields/order { ids: [...] } — every active field once, in the new order.
export async function handleReorderFields(req: Request, db: Db): Promise<Response> {
  const b = await body(req);
  if (b instanceof Response) return b;
  return guard(async () => {
    if (Array.isArray(b.ids) && b.ids.some((i) => typeof i !== "string" || !UUID_RE.test(i))) return errorResponse(400, "invalid_payload", "ids must be field ids");
    await reorderFields(db, b.ids);
    return jsonResponse({ ok: true });
  });
}

// GET /api/dashboard/devices/{id}/fields — the active fields with this device's text and date values.
// A secret only says whether it has a value; the value is available through the reveal route alone.
export async function handleDeviceFields(db: Db, deviceId: string): Promise<Response> {
  if (!UUID_RE.test(deviceId)) return errorResponse(404, "not_found", "No such device");
  const rows = await getDeviceFields(db, deviceId);
  return jsonResponse({
    fields: rows.map((r) => ({
      ...fieldJson(r.field),
      ...(r.field.type === "secret" ? { has_value: r.hasSecret } : { value: (r.field.type === "date" ? r.date : r.text) ?? null }),
    })),
  });
}

// PUT /api/dashboard/devices/{id}/fields/{fieldId} { value: string | null, reason? } — text and date fields.
export async function handleSetFieldValue(req: Request, db: Db, deviceId: string, fieldId: string, staffId: string): Promise<Response> {
  const b = await body(req);
  if (b instanceof Response) return b;
  if (!UUID_RE.test(deviceId) || !UUID_RE.test(fieldId)) return badId();
  if (b.reason !== undefined && b.reason !== null && typeof b.reason !== "string") return errorResponse(400, "invalid_payload", "reason must be a string");
  return guard(async () => jsonResponse(await setFieldValue(db, deviceId, fieldId, (b.value ?? null) as string | null, b.reason as string | null | undefined, staffId)));
}

// PUT /api/dashboard/devices/{id}/fields/{fieldId}/secret { value: string | null, pin } — needs the IT PIN.
// 403 wrong_pin / 429 too_many_attempts as everywhere else; 503 when SECRETS_KEY is missing.
export async function handleSetSecret(req: Request, db: Db, deviceId: string, fieldId: string, staffId: string): Promise<Response> {
  const b = await body(req);
  if (b instanceof Response) return b;
  if (!UUID_RE.test(deviceId) || !UUID_RE.test(fieldId)) return badId();
  return guard(async () => jsonResponse(await setSecret(db, deviceId, fieldId, (b.value ?? null) as string | null, b.pin, clientIp(req), staffId)));
}

// POST /api/dashboard/devices/{id}/fields/{fieldId}/reveal { pin } → { value }. The only response that
// ever carries a secret; the value is not logged anywhere, the access is.
export async function handleRevealSecret(req: Request, db: Db, deviceId: string, fieldId: string, staffId: string): Promise<Response> {
  const b = await body(req);
  if (b instanceof Response) return b;
  if (!UUID_RE.test(deviceId) || !UUID_RE.test(fieldId)) return badId();
  return guard(async () => jsonResponse(await revealSecret(db, deviceId, fieldId, b.pin, clientIp(req), staffId)));
}
