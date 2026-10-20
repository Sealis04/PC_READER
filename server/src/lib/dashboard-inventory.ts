import type { Db } from "@/db";
import { HttpError, errorResponse, jsonResponse, readJson } from "@/lib/http";
import { assignNextNumber, changeStatus, clearInventoryNumber, InventoryError, setInventoryNumber, setLocation, type DeviceStatus } from "@/lib/inventory";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ACTIONS = ["assign_next", "set_number", "clear_number", "set_status", "set_location"] as const;

// POST /api/dashboard/devices/{id}/inventory
// { "action": "assign_next" | "set_number" | "clear_number" | "set_status" | "set_location",
//   "value"?: string, "status"?: string, "reason"?: string }
// One change per call; the history row records the signed-in staff member (staffId). 200 with { changed, ... };
// 400 for bad input, 404 for an unknown device, 409 when the number is taken or the device already has one.
export async function handleInventoryAction(req: Request, db: Db, deviceId: string, staffId: string | null = null): Promise<Response> {
  let body: unknown;
  try {
    body = await readJson(req);
  } catch (e) {
    if (e instanceof HttpError) return e.response;
    throw e;
  }
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const action = ACTIONS.find((a) => a === b.action);
  if (!action) return errorResponse(400, "invalid_payload", `action must be one of ${ACTIONS.join(", ")}`);
  const text = (v: unknown): string | null | undefined => (v === undefined || v === null ? v : typeof v === "string" ? v : undefined);
  if (b.reason !== undefined && b.reason !== null && typeof b.reason !== "string") return errorResponse(400, "invalid_payload", "reason must be a string");
  if (!UUID_RE.test(deviceId)) return errorResponse(404, "not_found", "No such device");
  const reason = text(b.reason);

  try {
    switch (action) {
      case "assign_next":
        return jsonResponse({ changed: true, ...(await assignNextNumber(db, deviceId, reason, new Date(), staffId)) });
      case "set_number": {
        if (typeof b.value !== "string") return errorResponse(400, "invalid_payload", "value must be a string");
        return jsonResponse(await setInventoryNumber(db, deviceId, b.value, reason, staffId));
      }
      case "clear_number":
        return jsonResponse(await clearInventoryNumber(db, deviceId, reason, staffId));
      case "set_status":
        return jsonResponse(await changeStatus(db, deviceId, b.status as DeviceStatus, reason, staffId));
      case "set_location": {
        if (b.value !== null && typeof b.value !== "string") return errorResponse(400, "invalid_payload", "value must be a string or null");
        return jsonResponse(await setLocation(db, deviceId, b.value, reason, staffId));
      }
    }
  } catch (e) {
    if (e instanceof InventoryError) return errorResponse(e.status, e.code, e.message);
    throw e;
  }
}
