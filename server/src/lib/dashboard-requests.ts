import { desc, eq } from "drizzle-orm";
import type { Db } from "@/db";
import { deviceRequests } from "@/db/schema";
import { HttpError, errorResponse, jsonResponse, readJson } from "@/lib/http";
import { isRequestType, queueRequest, REQUEST_TYPES } from "@/lib/requests";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// POST /api/dashboard/devices/{id}/requests { "type": "scan_now" | "send_logs" | "prompt_details_update" }
// Queues a request for the PC (requested_by is the signed-in staff member). 201 for a new
// request, 200 with the existing one when the same type is already open.
export async function handleQueueRequest(req: Request, db: Db, deviceId: string, staffId: string | null = null): Promise<Response> {
  let body: unknown;
  try {
    body = await readJson(req);
  } catch (e) {
    if (e instanceof HttpError) return e.response;
    throw e;
  }
  const type = (body as { type?: unknown } | null)?.type;
  if (!isRequestType(type)) {
    return errorResponse(400, "invalid_payload", `type must be one of ${REQUEST_TYPES.join(", ")}`);
  }
  if (!UUID_RE.test(deviceId)) return errorResponse(404, "not_found", "No such device");
  const queued = await queueRequest(db, deviceId, type, staffId);
  if (!queued) return errorResponse(404, "not_found", "No such device");
  const { request } = queued;
  return jsonResponse(
    { id: request.id, type: request.type, status: request.status, created_at: request.createdAt.toISOString() },
    queued.created ? 201 : 200,
  );
}

// GET /api/dashboard/devices/{id}/requests — the device's latest requests, newest first.
export async function handleListRequests(db: Db, deviceId: string): Promise<Response> {
  if (!UUID_RE.test(deviceId)) return errorResponse(404, "not_found", "No such device");
  const rows = await db
    .select()
    .from(deviceRequests)
    .where(eq(deviceRequests.deviceId, deviceId))
    .orderBy(desc(deviceRequests.createdAt))
    .limit(20);
  return jsonResponse({
    requests: rows.map((r) => ({
      id: r.id,
      type: r.type,
      status: r.status,
      created_at: r.createdAt.toISOString(),
      delivered_at: r.deliveredAt?.toISOString() ?? null,
      completed_at: r.completedAt?.toISOString() ?? null,
      scan_id: r.scanId,
      message: r.message,
    })),
  });
}
