import { MAX_LOG_BATCH, formatErrors, validateLogsRequest, type LogsResponse } from "@pcreader/contracts";
import type { Db } from "@/db";
import { deviceLogs } from "@/db/schema";
import { authenticateDevice } from "@/lib/agent/auth";
import { HttpError, errorResponse, jsonResponse, readJson } from "@/lib/http";

// POST /api/agent/logs — uploads buffered local log entries. Entries already stored for this
// device (same local_entry_id) are ignored but still reported as received, so a retry after a
// lost response clears them from the agent's log. More than 500 entries is 413.
export async function handleLogs(req: Request, db: Db): Promise<Response> {
  const device = await authenticateDevice(req, db);
  if (!device) return errorResponse(401, "unauthorized", "Missing, invalid or revoked device token");

  let body: unknown;
  try {
    body = await readJson(req);
  } catch (e) {
    if (e instanceof HttpError) return e.response;
    throw e;
  }
  const entries = (body as { entries?: unknown } | null)?.entries;
  if (Array.isArray(entries) && entries.length > MAX_LOG_BATCH) {
    return errorResponse(413, "payload_too_large", `At most ${MAX_LOG_BATCH} entries per upload; split the batch`);
  }
  if (!validateLogsRequest(body)) {
    return errorResponse(400, "invalid_payload", "Request does not match logs.request schema", formatErrors(validateLogsRequest.errors));
  }

  const unique = [...new Map(body.entries.map((e) => [e.local_entry_id, e])).values()];
  await db
    .insert(deviceLogs)
    .values(
      unique.map((e) => ({
        deviceId: device.id,
        localEntryId: e.local_entry_id,
        loggedAt: new Date(e.logged_at),
        level: e.level,
        category: e.category,
        message: e.message,
      })),
    )
    .onConflictDoNothing({ target: [deviceLogs.deviceId, deviceLogs.localEntryId] });

  const response: LogsResponse = { received_ids: unique.map((e) => e.local_entry_id) };
  return jsonResponse(response);
}
