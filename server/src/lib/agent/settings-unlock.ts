import { formatErrors, validateSettingsUnlockRequest, type SettingsUnlockResponse } from "@pcreader/contracts";
import type { Db } from "@/db";
import { authenticateDevice } from "@/lib/agent/auth";
import { HttpError, errorResponse, jsonResponse, readJson } from "@/lib/http";
import { verifyPin } from "@/lib/it-pin";

// POST /api/agent/settings-unlock { pin } — the PC asks whether the typed PIN is the current IT PIN.
// 200 { ok: true }, 403 wrong_pin, 429 too_many_attempts. Every checked attempt is logged.
export async function handleSettingsUnlock(req: Request, db: Db): Promise<Response> {
  const device = await authenticateDevice(req, db);
  if (!device) return errorResponse(401, "unauthorized", "Missing or invalid device token");

  let body: unknown;
  try {
    body = await readJson(req);
  } catch (e) {
    if (e instanceof HttpError) return e.response;
    throw e;
  }
  if (!validateSettingsUnlockRequest(body)) {
    return errorResponse(400, "invalid_payload", "Request does not match settings-unlock.request schema", formatErrors(validateSettingsUnlockRequest.errors));
  }

  const result = await verifyPin(db, device.id, body.pin);
  if (result === "too_many_attempts") return errorResponse(429, "too_many_attempts", "Too many wrong PINs; try again in a minute");
  if (result === "wrong_pin") return errorResponse(403, "wrong_pin", "That PIN is not the current IT PIN");
  const response: SettingsUnlockResponse = { ok: true };
  return jsonResponse(response);
}
