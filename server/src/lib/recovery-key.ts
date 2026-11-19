import { createHash, pbkdf2Sync, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type { SecretHash } from "@pcreader/contracts";
import { and, count, desc, eq, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { devices, recoveryKeyAccessLog, recoveryKeys, type RecoveryKeyRow } from "@/db/schema";
import { verifyPin, type PinSubject, type VerifyResult } from "@/lib/it-pin";
import { broadcast } from "@/lib/notifier";
import { decryptSecret, encryptSecret, secretsDisabledReason } from "@/lib/secrets-crypto";
import { secretsMatch } from "@/lib/tokens";

// The recovery key (M7) is the enrollment key kept in the database: the current version registers PCs,
// and every version opens Settings offline on the PCs that hold its hash. This module is the only code
// that reads or writes recovery_keys. The key is stored only encrypted (SECRETS_KEY), compared through a
// SHA-256 of its normalized form, and reaches PCs only as a salted PBKDF2 hash (pc_hash) with its
// version. Without SECRETS_KEY nothing is stored: ENROLLMENT_KEY from the env is used as before.

// No 0/O or 1/I/L, so a key read aloud or copied by hand is unambiguous.
export const KEY_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const KEY_LENGTH = 16;
export const ROTATE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
export const ROTATION_CHECK_MS = 60 * 60 * 1000;

// PBKDF2 work factor of the hashes sent to PCs (the PC's config.SecretHash default). Tests lower it.
export const pcHashSettings = { iterations: 600_000 };

const SEED_LOCK = 0x70637263; // advisory lock id for seeding and rotation ("pcrc")

// Trim, upper-case, drop dashes and spaces: "k7qm-2xrp 9wdf-h4tn" is "K7QM2XRP9WDFH4TN".
export function normalizeKey(raw: string): string {
  return raw.trim().toUpperCase().replace(/[-\s]/g, "");
}

export function generateKey(): string {
  let key = "";
  for (let i = 0; i < KEY_LENGTH; i++) key += KEY_ALPHABET[randomInt(KEY_ALPHABET.length)];
  return key;
}

// "K7QM-2XRP-9WDF-H4TN" for a key in the new format; any other key (a seeded legacy one) as it is.
export function formatKey(key: string): string {
  const n = normalizeKey(key);
  if (n.length === KEY_LENGTH && [...n].every((c) => KEY_ALPHABET.includes(c))) return n.match(/.{4}/g)!.join("-");
  return key;
}

const verifyHashOf = (key: string) => createHash("sha256").update(normalizeKey(key)).digest("hex");

export function pcHashOf(key: string, iterations = pcHashSettings.iterations): SecretHash {
  const salt = randomBytes(16);
  const hash = pbkdf2Sync(normalizeKey(key), salt, iterations, 32, "sha256");
  return { algorithm: "pbkdf2-sha256", iterations, salt: salt.toString("base64"), hash: hash.toString("base64") };
}

const contextOf = (version: number) => `recovery-key:${version}`;

// Null when keys can be stored (SECRETS_KEY set and valid), else why not.
export const recoveryDisabledReason = (): string | null => secretsDisabledReason();

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

async function latest(db: Db | Tx): Promise<RecoveryKeyRow | null> {
  const [row] = await db.select().from(recoveryKeys).orderBy(desc(recoveryKeys.version)).limit(1);
  return row ?? null;
}

// Inserts the next version, retiring the current one. Call inside a transaction holding SEED_LOCK. The
// version is the serial; the ciphertext is bound to it, so the row is written in two steps.
async function insertKey(tx: Tx, key: string, source: RecoveryKeyRow["source"], now: Date): Promise<RecoveryKeyRow> {
  await tx.update(recoveryKeys).set({ retiredAt: now }).where(isNull(recoveryKeys.retiredAt));
  const [{ version }] = await tx.execute<{ version: number }>(sql`select nextval(pg_get_serial_sequence('recovery_keys', 'version'))::int as version`);
  const { ciphertext, nonce } = encryptSecret(key, contextOf(version));
  const [row] = await tx
    .insert(recoveryKeys)
    .values({ version, ciphertext, nonce, verifyHash: verifyHashOf(key), pcHash: pcHashOf(key), source, createdAt: now })
    .returning();
  return row;
}

// The current key; on an empty table it seeds version 1 from ENROLLMENT_KEY (an existing install keeps
// its key, which may be hex rather than the new format), or generates one when the env has none.
// Null without SECRETS_KEY.
export async function currentKey(db: Db, now = new Date()): Promise<RecoveryKeyRow | null> {
  if (recoveryDisabledReason()) return null;
  const row = await latest(db);
  if (row) return row;
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${SEED_LOCK})`);
    const again = await latest(tx);
    if (again) return again;
    const env = process.env.ENROLLMENT_KEY?.trim();
    return insertKey(tx, env || generateKey(), "seed", now);
  });
}

// Whether a typed enrollment key registers a PC: only the current version (no overlap after a rotation).
// Without SECRETS_KEY: ENROLLMENT_KEY as before; "disabled" when there is no key at all.
export async function currentKeyMatches(db: Db, typed: string): Promise<boolean | "disabled"> {
  const row = await currentKey(db);
  if (!row) {
    const env = process.env.ENROLLMENT_KEY;
    if (!env) return "disabled";
    return secretsMatch(typed, env) || secretsMatch(normalizeKey(typed), normalizeKey(env));
  }
  const a = Buffer.from(verifyHashOf(typed));
  const b = Buffer.from(row.verifyHash);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Notifies every open events stream so PCs receive the new hash at once.
async function rotateLocked(db: Db, source: "auto" | "manual", now: Date, onlyIfDue: boolean): Promise<RecoveryKeyRow | null> {
  const row = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${SEED_LOCK})`);
    const cur = await latest(tx);
    if (onlyIfDue && cur && now.getTime() - cur.createdAt.getTime() < ROTATE_AFTER_MS) return null;
    if (!cur && onlyIfDue) {
      return null;
    }
    return insertKey(tx, generateKey(), source, now);
  });
  if (row) broadcast("recovery_key");
  return row;
}

// The timer's check (on start and hourly): a new key when the current one is 30 days old.
export async function rotateIfDue(db: Db, now = new Date()): Promise<RecoveryKeyRow | null> {
  if (recoveryDisabledReason()) return null;
  await currentKey(db, now);
  const row = await rotateLocked(db, "auto", now, true);
  if (row) await db.insert(recoveryKeyAccessLog).values({ action: "rotate", version: row.version, success: true, accessedAt: now });
  return row;
}

export class RecoveryKeyError extends Error {
  constructor(
    public readonly status: 403 | 404 | 429 | 503,
    public readonly code: "wrong_pin" | "too_many_attempts" | "not_found" | "secrets_unavailable",
    message: string,
  ) {
    super(message);
  }
}

function refused(result: Exclude<VerifyResult, "ok">): RecoveryKeyError {
  return result === "too_many_attempts"
    ? new RecoveryKeyError(429, "too_many_attempts", "Too many wrong PINs; try again in a minute")
    : new RecoveryKeyError(403, "wrong_pin", "That PIN is not the current IT PIN");
}

function requireEnabled(): void {
  const reason = recoveryDisabledReason();
  if (reason) throw new RecoveryKeyError(503, "secrets_unavailable", `Recovery keys are not stored: ${reason}`);
}

// Dashboard "New key now": needs the current IT PIN. Every attempt is logged.
export async function rotateNowWithPin(db: Db, pin: unknown, clientIp: string, now = new Date()): Promise<{ version: number }> {
  requireEnabled();
  const result = await verifyPin(db, { deviceId: null, clientIp }, typeof pin === "string" ? pin.trim() : "", "rotate_recovery_key", now);
  if (result !== "ok") {
    await db.insert(recoveryKeyAccessLog).values({ action: "rotate", success: false, clientIp, accessedAt: now });
    throw refused(result);
  }
  await currentKey(db, now);
  const row = (await rotateLocked(db, "manual", now, false))!;
  await db.insert(recoveryKeyAccessLog).values({ action: "rotate", version: row.version, success: true, clientIp, accessedAt: now });
  return { version: row.version };
}

// The only function that returns a key. version null = the current one; deviceId names the device page
// it was revealed from (the PIN attempt then counts toward that device's limit).
export async function revealKey(
  db: Db,
  opts: { version: number | null; deviceId?: string | null },
  pin: unknown,
  clientIp: string,
  now = new Date(),
): Promise<{ version: number; key: string }> {
  requireEnabled();
  const deviceId = opts.deviceId ?? null;
  const subject: PinSubject = deviceId ? { deviceId } : { deviceId: null, clientIp };
  const result = await verifyPin(db, subject, typeof pin === "string" ? pin.trim() : "", "reveal_recovery_key", now);
  const log = (success: boolean, version: number | null) =>
    db.insert(recoveryKeyAccessLog).values({ action: "reveal", version, deviceId, success, clientIp, accessedAt: now });
  if (result !== "ok") {
    await log(false, opts.version);
    throw refused(result);
  }
  const row = opts.version === null ? await currentKey(db, now) : ((await db.select().from(recoveryKeys).where(eq(recoveryKeys.version, opts.version)))[0] ?? null);
  if (!row) {
    await log(false, opts.version);
    throw new RecoveryKeyError(404, "not_found", "There is no such recovery key version");
  }
  let key: string;
  try {
    key = decryptSecret(row.ciphertext, row.nonce, contextOf(row.version));
  } catch {
    await log(false, row.version);
    throw new RecoveryKeyError(503, "secrets_unavailable", "The recovery key cannot be decrypted (wrong SECRETS_KEY or damaged data)");
  }
  await log(true, row.version);
  return { version: row.version, key: formatKey(key) };
}

// What a PC is sent: the current version and its PBKDF2 hash. Null without SECRETS_KEY.
export async function pcHashForCurrent(db: Db): Promise<{ version: number; hash: SecretHash } | null> {
  const row = await currentKey(db);
  return row ? { version: row.version, hash: row.pcHash as SecretHash } : null;
}

// The PC saved this version's hash. False when the version does not exist.
export async function acknowledge(db: Db, deviceId: string, version: number, now = new Date()): Promise<boolean> {
  const [row] = await db.select({ version: recoveryKeys.version }).from(recoveryKeys).where(eq(recoveryKeys.version, version));
  if (!row) return false;
  await db.update(devices).set({ recoveryKeyVersion: version, recoveryKeyAckedAt: now }).where(eq(devices.id, deviceId));
  return true;
}

// A registered device (token set) whose acknowledged version is unknown or older than the current one.
export function behindCondition(currentVersion: number) {
  return and(isNotNull(devices.tokenHash), or(isNull(devices.recoveryKeyVersion), lt(devices.recoveryKeyVersion, currentVersion)));
}

export interface RecoveryStatus {
  enabled: boolean;
  disabledReason: string | null;
  version: number | null;
  createdAt: Date | null;
  source: RecoveryKeyRow["source"] | null;
  nextRotationAt: Date | null;
  // ENROLLMENT_KEY is set and is not the current key (it only seeded version 1; it is ignored now).
  envDiffers: boolean;
  behind: number;
}

export async function recoveryStatus(db: Db): Promise<RecoveryStatus> {
  const reason = recoveryDisabledReason();
  const row = reason ? null : await currentKey(db);
  if (!row) {
    return { enabled: false, disabledReason: reason, version: null, createdAt: null, source: null, nextRotationAt: null, envDiffers: false, behind: 0 };
  }
  const env = process.env.ENROLLMENT_KEY?.trim();
  const [{ behind }] = await db.select({ behind: count() }).from(devices).where(behindCondition(row.version));
  return {
    enabled: true,
    disabledReason: null,
    version: row.version,
    createdAt: row.createdAt,
    source: row.source,
    nextRotationAt: new Date(row.createdAt.getTime() + ROTATE_AFTER_MS),
    envDiffers: Boolean(env) && verifyHashOf(env!) !== row.verifyHash,
    behind,
  };
}

// "current" / "N behind" / "unknown" for a device page or list.
export function versionLabel(deviceVersion: number | null, currentVersion: number | null): string {
  if (deviceVersion === null) return "unknown";
  if (currentVersion === null || deviceVersion >= currentVersion) return `v${deviceVersion} (current)`;
  return `v${deviceVersion} (${currentVersion - deviceVersion} behind)`;
}

// Starts the in-process rotation timer once per server process (on start and hourly). This is a server
// timer, not PC polling.
export function startRotationTimer(db: Db): void {
  const g = globalThis as unknown as { __pcreaderRotationTimer?: ReturnType<typeof setInterval> };
  if (g.__pcreaderRotationTimer) return;
  const tick = () =>
    void rotateIfDue(db).catch((e) => {
      console.warn("recovery key rotation check failed:", e instanceof Error ? e.message : e);
    });
  tick();
  g.__pcreaderRotationTimer = setInterval(tick, ROTATION_CHECK_MS);
  g.__pcreaderRotationTimer.unref?.();
}
