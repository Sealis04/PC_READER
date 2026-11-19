import { formatErrors, validateMoveResultRequest, type MeResponse, type OkResponse } from "@pcreader/contracts";
import type { Db } from "@/db";
import { authenticateDevice } from "@/lib/agent/auth";
import { HttpError, errorResponse, jsonResponse, readJson } from "@/lib/http";
import { recordMoveResult } from "@/lib/server-move";

// GET /api/agent/me → { device_id }: which device this token belongs to. A PC asks a new server address
// before following a server move; 401 means the address does not know the token.
export async function handleMe(req: Request, db: Db): Promise<Response> {
  const device = await authenticateDevice(req, db);
  if (!device) return errorResponse(401, "unauthorized", "Missing or invalid device token");
  const response: MeResponse = { device_id: device.id };
  return jsonResponse(response);
}

// POST /api/agent/move-result { move_id, moved, reason? } — sent to the old server: moved just before
// the PC switches, or why it stays. 404 for an unknown move.
export async function handleMoveResult(req: Request, db: Db): Promise<Response> {
  const device = await authenticateDevice(req, db);
  if (!device) return errorResponse(401, "unauthorized", "Missing or invalid device token");
  let body: unknown;
  try {
    body = await readJson(req);
  } catch (e) {
    if (e instanceof HttpError) return e.response;
    throw e;
  }
  if (!validateMoveResultRequest(body)) {
    return errorResponse(400, "invalid_payload", "Request does not match move-result.request schema", formatErrors(validateMoveResultRequest.errors));
  }
  if (!(await recordMoveResult(db, device.id, body.move_id, body.moved, body.reason ?? null))) return errorResponse(404, "not_found", "No such server move");
  const response: OkResponse = { ok: true };
  return jsonResponse(response);
}
