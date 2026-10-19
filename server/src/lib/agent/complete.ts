import { formatErrors, validateRequestComplete, type RequestCompleteResponse } from "@pcreader/contracts";
import { and, eq } from "drizzle-orm";
import type { Db } from "@/db";
import { deviceRequests, scans } from "@/db/schema";
import { authenticateDevice } from "@/lib/agent/auth";
import { HttpError, errorResponse, jsonResponse, readJson } from "@/lib/http";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// POST /api/agent/requests/{id}/complete — the device reports how a dashboard request went.
// Only the owning device can complete it (anything else is 404). Idempotent: a finished
// request keeps its first outcome.
export async function handleRequestComplete(req: Request, db: Db, requestId: string): Promise<Response> {
  const device = await authenticateDevice(req, db);
  if (!device) return errorResponse(401, "unauthorized", "Missing, invalid or revoked device token");

  let body: unknown;
  try {
    body = await readJson(req);
  } catch (e) {
    if (e instanceof HttpError) return e.response;
    throw e;
  }
  if (!validateRequestComplete(body)) {
    return errorResponse(400, "invalid_payload", "Request does not match request-complete.request schema", formatErrors(validateRequestComplete.errors));
  }
  if (!UUID_RE.test(requestId)) return errorResponse(404, "not_found", "No such request for this device");

  const [existing] = await db
    .select()
    .from(deviceRequests)
    .where(and(eq(deviceRequests.id, requestId), eq(deviceRequests.deviceId, device.id)))
    .limit(1);
  if (!existing) return errorResponse(404, "not_found", "No such request for this device");

  if (existing.status === "done" || existing.status === "failed") {
    const done: RequestCompleteResponse = { id: existing.id, status: existing.status };
    return jsonResponse(done);
  }

  let scanId: string | null = null;
  if (body.scan_id) {
    const [scan] = await db
      .select({ id: scans.id })
      .from(scans)
      .where(and(eq(scans.id, body.scan_id), eq(scans.deviceId, device.id)))
      .limit(1);
    if (!scan) return errorResponse(400, "invalid_payload", "scan_id is not a scan of this device");
    scanId = scan.id;
  }

  const [updated] = await db
    .update(deviceRequests)
    .set({ status: body.result, completedAt: new Date(), scanId, message: body.message ?? null })
    .where(and(eq(deviceRequests.id, existing.id), eq(deviceRequests.status, existing.status)))
    .returning({ id: deviceRequests.id, status: deviceRequests.status });
  // Lost a race with a concurrent completion: report the stored outcome.
  const [final] = updated
    ? [updated]
    : await db.select({ id: deviceRequests.id, status: deviceRequests.status }).from(deviceRequests).where(eq(deviceRequests.id, existing.id));
  return jsonResponse({ id: final.id, status: final.status as "done" | "failed" } satisfies RequestCompleteResponse);
}
