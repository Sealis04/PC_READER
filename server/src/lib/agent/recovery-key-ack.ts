import { formatErrors, validateRecoveryKeyAckRequest, type OkResponse } from "@pcreader/contracts";
import type { Db } from "@/db";
import { authenticateDevice } from "@/lib/agent/auth";
import { HttpError, errorResponse, jsonResponse, readJson } from "@/lib/http";
import { acknowledge } from "@/lib/recovery-key";

// POST /api/agent/recovery-key/ack { version } — the PC saved that recovery key version's hash.
// 200 { ok: true }; 409 conflict for a version the server does not have.
export async function handleRecoveryKeyAck(req: Request, db: Db): Promise<Response> {
  const device = await authenticateDevice(req, db);
  if (!device) return errorResponse(401, "unauthorized", "Missing or invalid device token");
  let body: unknown;
  try {
    body = await readJson(req);
  } catch (e) {
    if (e instanceof HttpError) return e.response;
    throw e;
  }
  if (!validateRecoveryKeyAckRequest(body)) {
    return errorResponse(400, "invalid_payload", "Request does not match recovery-key-ack.request schema", formatErrors(validateRecoveryKeyAckRequest.errors));
  }
  if (!(await acknowledge(db, device.id, body.version))) return errorResponse(409, "conflict", "There is no such recovery key version");
  const response: OkResponse = { ok: true };
  return jsonResponse(response);
}
