import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  customType,
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

const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });

export const osType = pgEnum("os_type", ["windows", "macos"]);
export const deviceStatus = pgEnum("device_status", [
  "in_use",
  "spare",
  "under_repair",
  "for_disposal",
  "disposed",
  "lost",
]);
export const deviceHistoryField = pgEnum("device_history_field", ["inventory_number", "location", "custom_field"]);
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
export const unlockMethod = pgEnum("unlock_method", ["hourly_pin", "register", "update_details", "manual_scan", "confirm_details", "reveal_secret", "set_secret"]);
export const customFieldType = pgEnum("custom_field_type", ["text", "date", "secret"]);
export const secretAction = pgEnum("secret_action", ["reveal", "set", "clear"]);
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

// Append-only: one row per device status change (changed_by is the staff_user id; null for older rows).
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

// IT-defined extra fields, the same set for every device. Archived fields are hidden but their values
// are kept; fields are never deleted.
export const customFields = pgTable(
  "custom_fields",
  {
    ...base,
    name: text("name").notNull(),
    type: customFieldType("type").notNull(),
    position: integer("position").notNull().default(0),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [index("custom_fields_position_idx").on(t.position)],
);

// One value per device and field. text_value / date_value (YYYY-MM-DD) for text and date fields; a
// secret is only ever stored as AES-256-GCM ciphertext + nonce (see lib/secrets-crypto.ts).
export const deviceFieldValues = pgTable(
  "device_field_values",
  {
    deviceId: uuid("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    fieldId: uuid("field_id")
      .notNull()
      .references(() => customFields.id),
    textValue: text("text_value"),
    dateValue: text("date_value"),
    secretCiphertext: bytea("secret_ciphertext"),
    secretNonce: bytea("secret_nonce"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("device_field_values_device_field_idx").on(t.deviceId, t.fieldId), index("device_field_values_field_idx").on(t.fieldId)],
);

// Append-only: every reveal / set / clear of a secret value, successful or not. Never the value.
export const secretAccessLog = pgTable(
  "secret_access_log",
  {
    ...base,
    deviceId: uuid("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    fieldId: uuid("field_id")
      .notNull()
      .references(() => customFields.id),
    action: secretAction("action").notNull(),
    success: boolean("success").notNull(),
    clientIp: text("client_ip"),
    // The signed-in staff member (staff_user.id); null for rows written before staff login existed.
    staffUserId: text("staff_user_id").references(() => staffUser.id),
    accessedAt: timestamp("accessed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("secret_access_log_device_idx").on(t.deviceId, t.accessedAt)],
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
    // Set when field = custom_field (which custom field changed). Secret changes carry no values.
    customFieldId: uuid("custom_field_id").references(() => customFields.id),
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

// Single row (id = 1): this server's agency branding and inventory number prefix. Created lazily with
// the defaults; the migration that introduced it sets the prefix to IA when IA-YYYY-NNNNN numbers exist.
export const appSettings = pgTable("app_settings", {
  id: integer("id").primaryKey().default(1),
  agencyName: text("agency_name").notNull().default("PC_READER"),
  inventoryPrefix: text("inventory_prefix").notNull().default("INV"),
  logo: bytea("logo"),
  logoContentType: text("logo_content_type"),
  logoUpdatedAt: timestamp("logo_updated_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

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
    // The staff_user id for dashboard changes; "self-registration" / "self-service" when set by the agent.
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
    // The staff_user id; null for requests made before the dashboard had a login.
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

// Append-only: one row per IT PIN a PC checked with the server (Settings unlock, signup, Update my
// details, manual scan). Signup has no device yet: device_id is null and client_ip is the limiter key.
export const settingsUnlockAttempts = pgTable(
  "settings_unlock_attempts",
  {
    ...base,
    deviceId: uuid("device_id").references(() => devices.id, { onDelete: "cascade" }),
    clientIp: text("client_ip"),
    attemptedAt: timestamp("attempted_at", { withTimezone: true }).notNull().defaultNow(),
    success: boolean("success").notNull(),
    method: unlockMethod("method").notNull().default("hourly_pin"),
  },
  (t) => [
    index("settings_unlock_attempts_device_idx").on(t.deviceId, t.attemptedAt),
    index("settings_unlock_attempts_ip_idx").on(t.clientIp, t.attemptedAt),
  ],
);

// Staff accounts for the dashboard (Better Auth, HRIS as the OIDC provider). Prefixed `staff_` so they
// stay apart from `users` (the PCs' people). hris_sub is the join key; staff rows are never deleted.
export const staffUser = pgTable("staff_user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  hrisSub: text("hris_sub").notNull().unique(),
  employeeNumber: text("employee_number"),
  hrisUserLevel: text("hris_user_level"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const staffSession = pgTable(
  "staff_session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => staffUser.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("staff_session_user_idx").on(t.userId)],
);

export const staffAccount = pgTable(
  "staff_account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => staffUser.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("staff_account_user_idx").on(t.userId)],
);

export const staffVerification = pgTable(
  "staff_verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("staff_verification_identifier_idx").on(t.identifier)],
);

export const staffEventType = pgEnum("staff_event_type", ["login", "login_denied", "logout", "it_pin_rotated", "settings_changed", "logo_changed"]);

// Append-only: who signed in or changed something on the dashboard. Never holds tokens, codes or the PIN.
export const staffEvents = pgTable(
  "staff_events",
  {
    ...base,
    staffUserId: text("staff_user_id").references(() => staffUser.id),
    hrisSub: text("hris_sub"),
    type: staffEventType("type").notNull(),
    detail: text("detail"),
    clientIp: text("client_ip"),
  },
  (t) => [index("staff_events_created_idx").on(t.createdAt)],
);

export type Device = typeof devices.$inferSelect;
export type Component = typeof components.$inferSelect;
export type NewComponent = typeof components.$inferInsert;
export type DeviceRequest = typeof deviceRequests.$inferSelect;
export type NetworkLog = typeof networkLogs.$inferSelect;
export type DeviceLog = typeof deviceLogs.$inferSelect;
export type SettingsUnlockAttempt = typeof settingsUnlockAttempts.$inferSelect;
export type CustomField = typeof customFields.$inferSelect;
export type SecretAccessLogRow = typeof secretAccessLog.$inferSelect;
