import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { devices, type Device } from "@/db/schema";
import { bearerToken } from "@/lib/http";
import { hashToken } from "@/lib/tokens";

// Resolves the device for a request's bearer token; null when missing, unknown or revoked.
// Any authenticated agent call counts as the device being seen.
export async function authenticateDevice(req: Request, db: Db): Promise<Device | null> {
  const token = bearerToken(req);
  if (!token) return null;
  const [device] = await db.select().from(devices).where(eq(devices.tokenHash, hashToken(token))).limit(1);
  if (!device) return null;
  await db.update(devices).set({ lastSeenAt: new Date() }).where(eq(devices.id, device.id));
  return device;
}
