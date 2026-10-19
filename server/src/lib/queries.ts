import type { ScanPayload } from "@pcreader/contracts";
import { and, asc, desc, eq, gte, isNull, lt, or, type SQL } from "drizzle-orm";
import type { Db } from "@/db";
import {
  assignments,
  components,
  deviceFieldHistory,
  deviceLogs,
  deviceRequests,
  devices,
  networkLogs,
  scans,
  statusHistory,
  users,
  type DeviceLog,
} from "@/db/schema";
import { STALE_MS, type ConnectionState } from "@/lib/format";

// One query for the whole list (no per-device lookups): the connection filter is a WHERE on
// online / last_seen_at, which has an index.
export async function listDevices(db: Db, filter?: ConnectionState, now = new Date()) {
  const cutoff = new Date(now.getTime() - STALE_MS);
  const where: SQL | undefined =
    filter === "online"
      ? eq(devices.online, true)
      : filter === "offline"
        ? and(eq(devices.online, false), gte(devices.lastSeenAt, cutoff))
        : filter === "stale"
          ? and(eq(devices.online, false), or(isNull(devices.lastSeenAt), lt(devices.lastSeenAt, cutoff)))
          : undefined;
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
      online: devices.online,
      agentVersion: devices.agentVersion,
      userName: users.fullName,
      department: users.department,
    })
    .from(devices)
    .leftJoin(assignments, and(eq(assignments.deviceId, devices.id), isNull(assignments.endAt)))
    .leftJoin(users, eq(users.id, assignments.userId))
    .where(where)
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

// The newest request of each type, plus how many are still open (the page refreshes while any is).
export async function getLatestRequests(db: Db, deviceId: string) {
  const rows = await db
    .select()
    .from(deviceRequests)
    .where(eq(deviceRequests.deviceId, deviceId))
    .orderBy(desc(deviceRequests.createdAt))
    .limit(60);
  const latest = new Map<string, (typeof rows)[number]>();
  for (const r of rows) if (!latest.has(r.type)) latest.set(r.type, r);
  return latest;
}

export const LOG_LIMIT = 200;

export async function getDeviceLogs(db: Db, deviceId: string, level?: DeviceLog["level"]) {
  return db
    .select()
    .from(deviceLogs)
    .where(level ? and(eq(deviceLogs.deviceId, deviceId), eq(deviceLogs.level, level)) : eq(deviceLogs.deviceId, deviceId))
    .orderBy(desc(deviceLogs.loggedAt), desc(deviceLogs.localEntryId))
    .limit(LOG_LIMIT);
}

export const NETWORK_LIMIT = 50;

export async function getNetworkHistory(db: Db, deviceId: string) {
  return db
    .select()
    .from(networkLogs)
    .where(eq(networkLogs.deviceId, deviceId))
    .orderBy(desc(networkLogs.collectedAt))
    .limit(NETWORK_LIMIT);
}

export type HistoryEvent = {
  at: Date;
  kind: "status" | "inventory_number" | "location" | "assigned" | "unassigned";
  from: string | null;
  to: string | null;
  reason: string | null;
  by: string | null;
};

// One timeline of status, inventory number, location and assignment changes, newest first. The
// initial state (no number, status "in use") has no rows; assignments come from the assignments table.
export async function getDeviceHistory(db: Db, deviceId: string): Promise<HistoryEvent[]> {
  const [statuses, fields, assigned] = await Promise.all([
    db.select().from(statusHistory).where(eq(statusHistory.deviceId, deviceId)),
    db.select().from(deviceFieldHistory).where(eq(deviceFieldHistory.deviceId, deviceId)),
    db
      .select({ startAt: assignments.startAt, endAt: assignments.endAt, assignedBy: assignments.assignedBy, notes: assignments.notes, userName: users.fullName, employeeId: users.employeeId })
      .from(assignments)
      .innerJoin(users, eq(users.id, assignments.userId))
      .where(eq(assignments.deviceId, deviceId)),
  ]);
  const events: HistoryEvent[] = [
    ...statuses.map((r): HistoryEvent => ({ at: r.changedAt, kind: "status", from: r.oldStatus, to: r.newStatus, reason: r.reason, by: r.changedBy })),
    ...fields.map((r): HistoryEvent => ({ at: r.changedAt, kind: r.field, from: r.oldValue, to: r.newValue, reason: r.reason, by: r.changedBy })),
  ];
  for (const a of assigned) {
    const who = `${a.userName} (${a.employeeId})`;
    events.push({ at: a.startAt, kind: "assigned", from: null, to: who, reason: a.notes, by: a.assignedBy });
    if (a.endAt) events.push({ at: a.endAt, kind: "unassigned", from: who, to: null, reason: null, by: null });
  }
  return events.sort((x, y) => y.at.getTime() - x.at.getTime());
}
