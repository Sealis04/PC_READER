import type { RequestType } from "@pcreader/contracts";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@/db";
import { deviceRequests, devices, type DeviceRequest } from "@/db/schema";
import { notifyDevice } from "@/lib/notifier";

export const REQUEST_TYPES = ["scan_now", "send_logs", "prompt_details_update"] as const satisfies readonly RequestType[];

export function isRequestType(value: unknown): value is RequestType {
  return typeof value === "string" && (REQUEST_TYPES as readonly string[]).includes(value);
}

// Queues a request for a device. A device has at most one open (pending or delivered) request
// per type: asking again returns the existing one. Returns null when the device does not exist.
export async function queueRequest(
  db: Db,
  deviceId: string,
  type: RequestType,
  requestedBy: string | null = null,
): Promise<{ request: DeviceRequest; created: boolean } | null> {
  const [device] = await db.select({ id: devices.id }).from(devices).where(eq(devices.id, deviceId)).limit(1);
  if (!device) return null;

  const [inserted] = await db
    .insert(deviceRequests)
    .values({ deviceId, type, requestedBy })
    .onConflictDoNothing()
    .returning();
  if (inserted) {
    notifyDevice(deviceId);
    return { request: inserted, created: true };
  }
  const [existing] = await db
    .select()
    .from(deviceRequests)
    .where(and(eq(deviceRequests.deviceId, deviceId), eq(deviceRequests.type, type), inArray(deviceRequests.status, ["pending", "delivered"])))
    .orderBy(desc(deviceRequests.createdAt))
    .limit(1);
  // The open request finished between the insert and the lookup: queue a fresh one.
  if (!existing) return queueRequest(db, deviceId, type, requestedBy);
  return { request: existing, created: false };
}
