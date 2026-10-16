import type { ScanPayload } from "@pcreader/contracts";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "@/db";
import { assignments, components, devices, scans, users } from "@/db/schema";

export async function listDevices(db: Db) {
  return db
    .select({
      id: devices.id,
      hostname: devices.hostname,
      osType: devices.osType,
      manufacturer: devices.manufacturer,
      model: devices.model,
      serialNumber: devices.serialNumber,
      status: devices.status,
      inventoryNumber: devices.inventoryNumber,
      lastSeenAt: devices.lastSeenAt,
      lastFullScanAt: devices.lastFullScanAt,
      userName: users.fullName,
      department: users.department,
    })
    .from(devices)
    .leftJoin(assignments, and(eq(assignments.deviceId, devices.id), isNull(assignments.endAt)))
    .leftJoin(users, eq(users.id, assignments.userId))
    .orderBy(asc(devices.hostname));
}

export type DeviceListRow = Awaited<ReturnType<typeof listDevices>>[number];

export async function getDeviceDetail(db: Db, id: string) {
  const [device] = await db.select().from(devices).where(eq(devices.id, id)).limit(1);
  if (!device) return null;

  const [assignment] = await db
    .select({ startAt: assignments.startAt, assignedBy: assignments.assignedBy, user: users })
    .from(assignments)
    .innerJoin(users, eq(users.id, assignments.userId))
    .where(and(eq(assignments.deviceId, id), isNull(assignments.endAt)))
    .limit(1);

  const parts = await db
    .select()
    .from(components)
    .where(eq(components.deviceId, id))
    .orderBy(asc(components.category), asc(components.firstSeenAt));

  const [latestScan] = await db
    .select({ id: scans.id, scanType: scans.scanType, collectedAt: scans.collectedAt, receivedAt: scans.receivedAt, payload: scans.payload })
    .from(scans)
    .where(eq(scans.deviceId, id))
    .orderBy(desc(scans.collectedAt))
    .limit(1);

  return {
    device,
    assignment: assignment ?? null,
    active: parts.filter((c) => !c.removedAt),
    removed: parts.filter((c) => c.removedAt),
    latestScan: latestScan ? { ...latestScan, payload: latestScan.payload as ScanPayload } : null,
  };
}
