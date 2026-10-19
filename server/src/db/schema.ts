import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// Columns shared by every table (spec: id UUID, created_at, updated_at).
const base = {
  id: uuid("id").primaryKey().defaultRandom(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

export const osType = pgEnum("os_type", ["windows", "macos"]);
export const deviceStatus = pgEnum("device_status", [
  "in_use",
  "spare",
  "under_repair",
  "for_disposal",
  "disposed",
  "lost",
]);
export const componentCategory = pgEnum("component_category", [
  "cpu",
  "ram",
  "storage",
  "motherboard",
  "gpu",
  "nic",
  "psu",
]);
export const scanType = pgEnum("scan_type", ["scheduled", "startup", "on_demand", "manual"]);

export const users = pgTable("users", {
  ...base,
  fullName: text("full_name").notNull(),
  employeeId: text("employee_id").notNull().unique(),
  email: text("email"),
  department: text("department").notNull(),
  position: text("position"),
  phone: text("phone"),
  policyAcknowledgedAt: timestamp("policy_acknowledged_at", { withTimezone: true }),
});

export const devices = pgTable(
  "devices",
  {
    ...base,
    deviceUuid: uuid("device_uuid").notNull().unique(),
    inventoryNumber: text("inventory_number").unique(),
    hostname: text("hostname").notNull(),
    osType: osType("os_type").notNull(),
    deviceType: text("device_type"),
    manufacturer: text("manufacturer"),
    model: text("model"),
    serialNumber: text("serial_number"),
    status: deviceStatus("status").notNull().default("in_use"),
    location: text("location"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    lastFullScanAt: timestamp("last_full_scan_at", { withTimezone: true }),
    // SHA-256 of the device token; null when revoked (forces re-registration).
    tokenHash: text("token_hash"),
  },
  (t) => [uniqueIndex("devices_token_hash_idx").on(t.tokenHash)],
);

export const components = pgTable(
  "components",
  {
    ...base,
    deviceId: uuid("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    category: componentCategory("category").notNull(),
    // Stable identity within a device across scans (serial, MAC or slot based).
    matchKey: text("match_key").notNull(),
    manufacturer: text("manufacturer"),
    model: text("model"),
    serialNumber: text("serial_number"),
    capacityBytes: bigint("capacity_bytes", { mode: "number" }),
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
    inventoryNumber: text("inventory_number").unique(),
    isIntegrated: boolean("is_integrated").notNull().default(false),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    removedAt: timestamp("removed_at", { withTimezone: true }),
  },
  (t) => [
    index("components_device_idx").on(t.deviceId),
    uniqueIndex("components_active_match_idx")
      .on(t.deviceId, t.matchKey)
      .where(sql`${t.removedAt} is null`),
  ],
);

export const assignments = pgTable(
  "assignments",
  {
    ...base,
    deviceId: uuid("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    startAt: timestamp("start_at", { withTimezone: true }).notNull().defaultNow(),
    endAt: timestamp("end_at", { withTimezone: true }),
    // Staff member for dashboard changes; "self-registration" when set by the agent.
    assignedBy: text("assigned_by").notNull(),
    notes: text("notes"),
  },
  (t) => [
    index("assignments_device_idx").on(t.deviceId),
    uniqueIndex("assignments_one_open_idx").on(t.deviceId).where(sql`${t.endAt} is null`),
  ],
);

export const scans = pgTable(
  "scans",
  {
    ...base,
    deviceId: uuid("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    scanUuid: uuid("scan_uuid").notNull().unique(),
    scanType: scanType("scan_type").notNull(),
    collectedAt: timestamp("collected_at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    payload: jsonb("payload").notNull(),
    schemaVersion: integer("schema_version").notNull(),
  },
  (t) => [index("scans_device_collected_idx").on(t.deviceId, t.collectedAt)],
);

export type Device = typeof devices.$inferSelect;
export type Component = typeof components.$inferSelect;
export type NewComponent = typeof components.$inferInsert;
