import type { ScanPayload } from "@pcreader/contracts";
import { and, asc, desc, eq, exists, gte, ilike, isNull, lt, lte, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "@/db";
import {
  assignments,
  components,
  customFields,
  deviceFieldHistory,
  deviceFieldValues,
  deviceLogs,
  deviceRequests,
  devices,
  networkLogs,
  scans,
  statusHistory,
  users,
  type Device,
  type DeviceLog,
} from "@/db/schema";
import { STALE_MS, type ConnectionState } from "@/lib/format";

export interface DeviceListFilters {
  connection?: ConnectionState;
  status?: Device["status"];
  department?: string;
  os?: Device["osType"];
  // Matches inventory number, hostname, serial number, and the assigned user's name or employee ID.
  q?: string;
  // Custom date field filter: devices whose value for this field is on/after `after` and/or on/before
  // `before` (YYYY-MM-DD). Devices without a value never match.
  dateField?: { fieldId: string; after?: string; before?: string };
}

function dateCondition(db: Db, f: DeviceListFilters["dateField"]): SQL | undefined {
  if (!f || (!f.after && !f.before)) return undefined;
  return exists(
    db
      .select({ one: sql`1` })
      .from(deviceFieldValues)
      .innerJoin(customFields, eq(customFields.id, deviceFieldValues.fieldId))
      .where(
        and(
          eq(deviceFieldValues.deviceId, devices.id),
          eq(deviceFieldValues.fieldId, f.fieldId),
          eq(customFields.type, "date"),
          isNull(customFields.archivedAt),
          // YYYY-MM-DD strings compare correctly as text.
          f.after ? gte(deviceFieldValues.dateValue, f.after) : undefined,
          f.before ? lte(deviceFieldValues.dateValue, f.before) : undefined,
        ),
      ),
  );
}

// One query for the whole list (no per-device lookups). The connection and status filters are
// WHEREs on indexed columns; search is a case-insensitive substring match, which is cheap at the
// expected scale (about 1,000 devices).
export async function listDevices(db: Db, filters: DeviceListFilters = {}, now = new Date()) {
  const cutoff = new Date(now.getTime() - STALE_MS);
  const { connection, status, department, os } = filters;
  const q = filters.q?.trim();
  const pattern = q ? `%${q.replace(/[\\%_]/g, "\\$&")}%` : null;
  const conditions: Array<SQL | undefined> = [
    connection === "online"
      ? eq(devices.online, true)
      : connection === "offline"
        ? and(eq(devices.online, false), gte(devices.lastSeenAt, cutoff))
        : connection === "stale"
          ? and(eq(devices.online, false), or(isNull(devices.lastSeenAt), lt(devices.lastSeenAt, cutoff)))
          : undefined,
    status ? eq(devices.status, status) : undefined,
    os ? eq(devices.osType, os) : undefined,
    department ? eq(users.department, department) : undefined,
    pattern
      ? or(
          ilike(devices.inventoryNumber, pattern),
          ilike(devices.hostname, pattern),
          ilike(devices.serialNumber, pattern),
          ilike(users.fullName, pattern),
          ilike(users.employeeId, pattern),
          // Text custom fields are searchable; secrets and dates are not part of q.
          exists(
            db
              .select({ one: sql`1` })
              .from(deviceFieldValues)
              .innerJoin(customFields, eq(customFields.id, deviceFieldValues.fieldId))
              .where(and(eq(deviceFieldValues.deviceId, devices.id), eq(customFields.type, "text"), isNull(customFields.archivedAt), ilike(deviceFieldValues.textValue, pattern))),
          ),
        )
      : undefined,
    dateCondition(db, filters.dateField),
  ];
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
      location: devices.location,
      lastSeenAt: devices.lastSeenAt,
      lastFullScanAt: devices.lastFullScanAt,
      online: devices.online,
      agentVersion: devices.agentVersion,
      userName: users.fullName,
      employeeId: users.employeeId,
      department: users.department,
    })
    .from(devices)
    .leftJoin(assignments, and(eq(assignments.deviceId, devices.id), isNull(assignments.endAt)))
    .leftJoin(users, eq(users.id, assignments.userId))
    .where(and(...conditions))
    .orderBy(asc(devices.hostname));
}

// Departments of currently assigned users, for the list's department filter.
export async function listDepartments(db: Db): Promise<string[]> {
  const rows = await db.selectDistinct({ department: users.department }).from(users).orderBy(asc(users.department));
  return rows.map((r) => r.department);
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
  kind: "status" | "inventory_number" | "location" | "custom_field" | "assigned" | "unassigned";
  // custom_field only: the field's name, and whether it is a secret (values are never recorded).
  fieldName?: string | null;
  secret?: boolean;
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
    db
      .select({ row: deviceFieldHistory, fieldName: customFields.name, fieldType: customFields.type })
      .from(deviceFieldHistory)
      .leftJoin(customFields, eq(customFields.id, deviceFieldHistory.customFieldId))
      .where(eq(deviceFieldHistory.deviceId, deviceId)),
    db
      .select({ startAt: assignments.startAt, endAt: assignments.endAt, assignedBy: assignments.assignedBy, notes: assignments.notes, userName: users.fullName, employeeId: users.employeeId })
      .from(assignments)
      .innerJoin(users, eq(users.id, assignments.userId))
      .where(eq(assignments.deviceId, deviceId)),
  ]);
  const events: HistoryEvent[] = [
    ...statuses.map((r): HistoryEvent => ({ at: r.changedAt, kind: "status", from: r.oldStatus, to: r.newStatus, reason: r.reason, by: r.changedBy })),
    ...fields.map(
      ({ row: r, fieldName, fieldType }): HistoryEvent => ({
        at: r.changedAt,
        kind: r.field,
        from: r.oldValue,
        to: r.newValue,
        reason: r.reason,
        by: r.changedBy,
        ...(r.field === "custom_field" && { fieldName, secret: fieldType === "secret" }),
      }),
    ),
  ];
  for (const a of assigned) {
    const who = `${a.userName} (${a.employeeId})`;
    events.push({ at: a.startAt, kind: "assigned", from: null, to: who, reason: a.notes, by: a.assignedBy });
    if (a.endAt) events.push({ at: a.endAt, kind: "unassigned", from: who, to: null, reason: null, by: null });
  }
  return events.sort((x, y) => y.at.getTime() - x.at.getTime());
}
