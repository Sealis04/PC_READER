import type { RequestType } from "@pcreader/contracts";
import { and, desc, eq, inArray, lt } from "drizzle-orm";
import type { Db } from "@/db";
import { deviceRequests, devices, type DeviceRequest } from "@/db/schema";
import { CONFIRM_APPROVAL_TTL_MS } from "@/lib/it-pin";
import { notifyDevice } from "@/lib/notifier";

export const PROMPT_EXPIRED_MESSAGE = "The user did not confirm within 24 hours";

// A "confirm details" request is answered by the user's save (PUT /user), not by the agent. One the user
// left alone for 24 hours is closed as failed, so its approval code stops working and a new one can be queued.
export async function expireStalePrompts(db: Db, deviceId: string, now = new Date()): Promise<void> {
  await db
    .update(deviceRequests)
    .set({ status: "failed", completedAt: now, message: PROMPT_EXPIRED_MESSAGE, updatedAt: now })
    .where(
      and(
        eq(deviceRequests.deviceId, deviceId),
        eq(deviceRequests.type, "prompt_details_update"),
        inArray(deviceRequests.status, ["pending", "delivered"]),
        lt(deviceRequests.createdAt, new Date(now.getTime() - CONFIRM_APPROVAL_TTL_MS)),
      ),
    );
}

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
  if (type === "prompt_details_update") await expireStalePrompts(db, deviceId);

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
