import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { devices } from "@/db/schema";
import { HttpError, errorResponse, jsonResponse, readJson } from "@/lib/http";
import { clientIp } from "@/lib/it-pin";
import { RecoveryKeyError, recoveryStatus, revealKey, rotateNowWithPin } from "@/lib/recovery-key";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function body(req: Request): Promise<Record<string, unknown> | Response> {
  try {
    const b = await readJson(req);
    return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
  } catch (e) {
    if (e instanceof HttpError) return e.response;
    throw e;
  }
}

async function guard(run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof RecoveryKeyError) return errorResponse(e.status, e.code, e.message);
    throw e;
  }
}

// GET /api/dashboard/recovery-key — version, dates and counts; never the key.
export async function handleRecoveryStatus(db: Db): Promise<Response> {
  const s = await recoveryStatus(db);
  return jsonResponse({
    enabled: s.enabled,
    disabled_reason: s.disabledReason,
    version: s.version,
    created_at: s.createdAt?.toISOString() ?? null,
    source: s.source,
    next_rotation_at: s.nextRotationAt?.toISOString() ?? null,
    env_differs: s.envDiffers,
    behind: s.behind,
  });
}

// POST /api/dashboard/recovery-key/reveal { pin, version? } → { version, key }. With the current IT PIN;
// every attempt is logged in recovery_key_access_log (never the key).
export async function handleRevealRecoveryKey(req: Request, db: Db): Promise<Response> {
  const b = await body(req);
  if (b instanceof Response) return b;
  const version = b.version === undefined || b.version === null ? null : b.version;
  if (version !== null && !(Number.isInteger(version) && (version as number) >= 1)) return errorResponse(400, "invalid_payload", "version must be a positive integer");
  return guard(async () => jsonResponse(await revealKey(db, { version: version as number | null }, b.pin, clientIp(req))));
}

// POST /api/dashboard/recovery-key/rotate { pin } → { version }: "New key now".
export async function handleRotateRecoveryKey(req: Request, db: Db): Promise<Response> {
  const b = await body(req);
  if (b instanceof Response) return b;
  return guard(async () => jsonResponse(await rotateNowWithPin(db, b.pin, clientIp(req))));
}

// POST /api/dashboard/devices/{id}/recovery-key/reveal { pin } → { version, key }: the version this PC
// acknowledged. 404 when the device is unknown or has never acknowledged one.
export async function handleRevealDeviceRecoveryKey(req: Request, db: Db, deviceId: string): Promise<Response> {
  const b = await body(req);
  if (b instanceof Response) return b;
  if (!UUID_RE.test(deviceId)) return errorResponse(404, "not_found", "No such device");
  const [device] = await db.select({ id: devices.id, version: devices.recoveryKeyVersion }).from(devices).where(eq(devices.id, deviceId));
  if (!device) return errorResponse(404, "not_found", "No such device");
  if (device.version === null) return errorResponse(404, "not_found", "This PC has not reported which recovery key it holds");
  return guard(async () => jsonResponse(await revealKey(db, { version: device.version, deviceId: device.id }, b.pin, clientIp(req))));
}
