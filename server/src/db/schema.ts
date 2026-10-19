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
export const deviceHistoryField = pgEnum("device_history_field", ["inventory_number", "location"]);
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

export const requestType = pgEnum("request_type", ["scan_now", "send_logs", "prompt_details_update"]);
export const requestStatus = pgEnum("request_status", ["pending", "delivered", "done", "failed"]);
export const connectionType = pgEnum("connection_type", ["ethernet", "wifi", "other"]);
export const logLevel = pgEnum("log_level", ["error", "warning", "info"]);
export const unlockMethod = pgEnum("unlock_method", ["hourly_pin"]);
export const logCategory = pgEnum("log_category", ["scan", "sync", "signup", "update", "system"]);

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
    inventoryNumber: text("inventory_number"),
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
    agentVersion: text("agent_version"),
    // True while the agent's events stream is open. connection_id names that stream, so a stream
    // that closes after a newer one opened does not flip the device offline.
    online: boolean("online").notNull().default(false),
    connectionId: uuid("connection_id"),
    connectedAt: timestamp("connected_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("devices_token_hash_idx").on(t.tokenHash),
    index("devices_last_seen_idx").on(t.lastSeenAt),
    // Inventory numbers are unique regardless of case ("ia-2026-00001" is "IA-2026-00001").
    uniqueIndex("devices_inventory_number_lower_idx").on(sql`lower(${t.inventoryNumber})`),
    index("devices_status_idx").on(t.status),
  ],
);

// Append-only: one row per device status change (changed_by is null until the dashboard has staff login).
export const statusHistory = pgTable(
  "status_history",
  {
    ...base,
    deviceId: uuid("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    oldStatus: deviceStatus("old_status").notNull(),
    newStatus: deviceStatus("new_status").notNull(),
    changedBy: text("changed_by"),
    changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
    reason: text("reason"),
  },
  (t) => [index("status_history_device_idx").on(t.deviceId, t.changedAt)],
);

// Append-only: one row per change of a device's inventory number or location (null = not set).
export const deviceFieldHistory = pgTable(
  "device_field_history",
  {
    ...base,
    deviceId: uuid("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    field: deviceHistoryField("field").notNull(),
    oldValue: text("old_value"),
    newValue: text("new_value"),
    changedBy: text("changed_by"),
    changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
    reason: text("reason"),
  },
  (t) => [index("device_field_history_device_idx").on(t.deviceId, t.changedAt)],
);

// Highest generated (or typed, pattern-matching) inventory number per year. Only ever raised, so a
// number is never issued twice.
export const inventoryCounters = pgTable("inventory_counters", {
  year: integer("year").primaryKey(),
  lastValue: integer("last_value").notNull(),
});

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

// A dashboard request for a PC (scan now, send logs, ask the user to confirm details).
export const deviceRequests = pgTable(
  "device_requests",
  {
    ...base,
    deviceId: uuid("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    type: requestType("type").notNull(),
    status: requestStatus("status").notNull().default("pending"),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    scanId: uuid("scan_id").references(() => scans.id, { onDelete: "set null" }),
    message: text("message"),
    // Null until the dashboard has staff login.
    requestedBy: text("requested_by"),
  },
  (t) => [
    index("device_requests_device_idx").on(t.deviceId, t.createdAt),
    // One open (pending or delivered) request per type per device.
    uniqueIndex("device_requests_open_idx")
      .on(t.deviceId, t.type)
      .where(sql`${t.status} in ('pending', 'delivered')`),
  ],
);

// Append-only: one row per network snapshot the agent sent.
export const networkLogs = pgTable(
  "network_logs",
  {
    ...base,
    deviceId: uuid("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    collectedAt: timestamp("collected_at", { withTimezone: true }).notNull(),
    ipAddresses: text("ip_addresses").array().notNull(),
    macAddresses: text("mac_addresses").array().notNull(),
    gateway: text("gateway"),
    dnsServers: text("dns_servers").array().notNull(),
    connectionType: connectionType("connection_type").notNull(),
    ssid: text("ssid"),
    online: boolean("online").notNull().default(true),
  },
  (t) => [index("network_logs_device_collected_idx").on(t.deviceId, t.collectedAt)],
);

// Entries the agent uploaded from its local log; (device_id, local_entry_id) ignores duplicate uploads.
export const deviceLogs = pgTable(
  "device_logs",
  {
    ...base,
    deviceId: uuid("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    localEntryId: bigint("local_entry_id", { mode: "number" }).notNull(),
    loggedAt: timestamp("logged_at", { withTimezone: true }).notNull(),
    level: logLevel("level").notNull(),
    category: logCategory("category").notNull(),
    message: text("message").notNull(),
  },
  (t) => [
    uniqueIndex("device_logs_entry_idx").on(t.deviceId, t.localEntryId),
    index("device_logs_device_logged_idx").on(t.deviceId, t.loggedAt),
  ],
);

// The single row behind the hourly IT PIN: the HMAC secret (unused when IT_PIN_SECRET is set) and the
// generation that "Change now" bumps. Never sent to a PC.
export const itPinState = pgTable("it_pin_state", {
  id: integer("id").primaryKey().default(1),
  secret: text("secret").notNull(),
  generation: integer("generation").notNull().default(0),
  rotatedAt: timestamp("rotated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Append-only: one row per Settings unlock attempt a PC checked with the server.
export const settingsUnlockAttempts = pgTable(
  "settings_unlock_attempts",
  {
    ...base,
    deviceId: uuid("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    attemptedAt: timestamp("attempted_at", { withTimezone: true }).notNull().defaultNow(),
    success: boolean("success").notNull(),
    method: unlockMethod("method").notNull().default("hourly_pin"),
  },
  (t) => [index("settings_unlock_attempts_device_idx").on(t.deviceId, t.attemptedAt)],
);

export type Device = typeof devices.$inferSelect;
export type Component = typeof components.$inferSelect;
export type NewComponent = typeof components.$inferInsert;
export type DeviceRequest = typeof deviceRequests.$inferSelect;
export type NetworkLog = typeof networkLogs.$inferSelect;
export type DeviceLog = typeof deviceLogs.$inferSelect;
export type SettingsUnlockAttempt = typeof settingsUnlockAttempts.$inferSelect;
