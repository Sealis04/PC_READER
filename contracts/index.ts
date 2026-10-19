// Shared agent API contract: JSON Schemas plus compiled validators and TypeScript types.
import Ajv2020, { type ErrorObject } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import scanPayloadSchema from "./scan-payload.v1.schema.json";
import registerRequestSchema from "./agent-api/register.request.schema.json";
import registerResponseSchema from "./agent-api/register.response.schema.json";
import userRequestSchema from "./agent-api/user.request.schema.json";
import scansRequestSchema from "./agent-api/scans.request.schema.json";
import scansResponseSchema from "./agent-api/scans.response.schema.json";
import networkSnapshotSchema from "./agent-api/network-snapshot.schema.json";
import networkRequestSchema from "./agent-api/network.request.schema.json";
import eventsRequestSchema from "./agent-api/events.request.schema.json";
import eventsMessageSchema from "./agent-api/events.message.schema.json";
import logsRequestSchema from "./agent-api/logs.request.schema.json";
import logsResponseSchema from "./agent-api/logs.response.schema.json";
import requestCompleteSchema from "./agent-api/request-complete.request.schema.json";
import requestCompleteResponseSchema from "./agent-api/request-complete.response.schema.json";

export const schemas = {
  scanPayload: scanPayloadSchema,
  registerRequest: registerRequestSchema,
  registerResponse: registerResponseSchema,
  userRequest: userRequestSchema,
  scansRequest: scansRequestSchema,
  scansResponse: scansResponseSchema,
  networkSnapshot: networkSnapshotSchema,
  networkRequest: networkRequestSchema,
  eventsRequest: eventsRequestSchema,
  eventsMessage: eventsMessageSchema,
  logsRequest: logsRequestSchema,
  logsResponse: logsResponseSchema,
  requestComplete: requestCompleteSchema,
  requestCompleteResponse: requestCompleteResponseSchema,
};

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
ajv.addSchema(scanPayloadSchema);
ajv.addSchema(networkSnapshotSchema);

export const validateScanPayload = ajv.compile<ScanPayload>(scanPayloadSchema);
export const validateRegisterRequest = ajv.compile<RegisterRequest>(registerRequestSchema);
export const validateRegisterResponse = ajv.compile<RegisterResponse>(registerResponseSchema);
export const validateUserRequest = ajv.compile<UserDetails>(userRequestSchema);
export const validateScansRequest = ajv.compile<ScansRequest>(scansRequestSchema);
export const validateScansResponse = ajv.compile<ScansResponse>(scansResponseSchema);

export const validateNetworkSnapshot = ajv.compile<NetworkSnapshot>(networkSnapshotSchema);
export const validateNetworkRequest = ajv.compile<NetworkSnapshot>(networkRequestSchema);
export const validateEventsRequest = ajv.compile<EventsQuery>(eventsRequestSchema);
export const validateEventsMessage = ajv.compile<EventsMessage>(eventsMessageSchema);
export const validateLogsRequest = ajv.compile<LogsRequest>(logsRequestSchema);
export const validateLogsResponse = ajv.compile<LogsResponse>(logsResponseSchema);
export const validateRequestComplete = ajv.compile<RequestCompleteRequest>(requestCompleteSchema);

export const validateRequestCompleteResponse = ajv.compile<RequestCompleteResponse>(requestCompleteResponseSchema);

export type ValidationIssue = { path: string; message: string };

export function formatErrors(errors: ErrorObject[] | null | undefined): ValidationIssue[] {
  return (errors ?? []).map((e) => ({ path: e.instancePath || "/", message: e.message ?? "invalid" }));
}

export type OsType = "windows" | "macos";
export type ScanType = "scheduled" | "startup" | "on_demand" | "manual";

export interface ScanPayload {
  schema_version: 1;
  os_type: OsType;
  agent_version: string;
  system: {
    manufacturer: string | null;
    model: string | null;
    serial_number: string | null;
    hardware_uuid: string | null;
    hostname: string;
    os_name: string | null;
    os_version: string | null;
    os_build: string | null;
    firmware_version: string | null;
    chip_name: string | null;
  };
  cpus: Array<{
    manufacturer: string | null;
    model: string | null;
    cores: number | null;
    threads: number | null;
    base_speed_mhz: number | null;
    is_integrated: boolean;
  }>;
  memory: {
    total_bytes: number | null;
    is_integrated: boolean;
    modules: Array<{
      slot: string | null;
      manufacturer: string | null;
      size_bytes: number | null;
      speed_mhz: number | null;
      part_number: string | null;
      serial_number: string | null;
    }> | null;
  };
  storage: Array<{
    model: string | null;
    serial_number: string | null;
    size_bytes: number | null;
    media_type: "ssd" | "hdd" | "unknown" | null;
    bus_type: string | null;
    is_internal: boolean | null;
    is_integrated: boolean;
  }>;
  volumes: Array<{
    mount_point: string;
    label: string | null;
    filesystem: string | null;
    size_bytes: number | null;
    free_bytes: number | null;
  }>;
  motherboard: { manufacturer: string | null; product: string | null; serial_number: string | null } | null;
  gpus: Array<{ name: string | null; memory_bytes: number | null; driver_version: string | null; is_integrated: boolean }>;
  network: {
    adapters: Array<{
      name: string;
      mac_address: string | null;
      type: "ethernet" | "wifi" | "other";
      is_physical: boolean;
      ip_addresses: string[];
      gateway: string | null;
      dns_servers: string[];
      dhcp_enabled: boolean | null;
    }>;
    wifi_ssid: string | null;
  };
}

export interface UserDetails {
  full_name: string;
  employee_id: string;
  email: string | null;
  department: string;
  position: string | null;
  phone: string | null;
}

export interface RegisterRequest {
  enrollment_key: string;
  device_uuid: string;
  os_type: OsType;
  hostname: string;
  hardware_summary: { manufacturer: string | null; model: string | null; serial_number: string | null };
  user: {
    full_name: string;
    employee_id: string;
    email: string | null;
    department: string;
    position: string | null;
    phone: string | null;
    policy_acknowledged: true;
  };
}

export interface RegisterResponse {
  device_id: string;
  device_token: string;
  checkin_interval_seconds: number;
}

export interface ScansRequest {
  scan_uuid: string;
  scan_type: ScanType;
  collected_at: string;
  payload: ScanPayload;
}

export interface ScansResponse {
  scan_id: string;
}

export type ConnectionType = "ethernet" | "wifi" | "other";

export interface NetworkSnapshot {
  collected_at: string;
  ip_addresses: string[];
  mac_addresses: string[];
  gateway: string | null;
  dns_servers: string[];
  connection_type: ConnectionType;
  ssid: string | null;
}

export type RequestType = "scan_now" | "send_logs" | "prompt_details_update";

export interface EventsQuery {
  agent_version: string;
}

export interface PendingRequest {
  id: string;
  type: RequestType;
  created_at: string;
}

export type EventsMessage =
  | { event: "hello"; data: { heartbeat_seconds: number } }
  | { event: "request"; data: PendingRequest };

export const MAX_LOG_BATCH = 500;

export type LogLevel = "error" | "warning" | "info";
export type LogCategory = "scan" | "sync" | "signup" | "update" | "system";

export interface LogEntry {
  local_entry_id: number;
  logged_at: string;
  level: LogLevel;
  category: LogCategory;
  message: string;
}

export interface LogsRequest {
  entries: LogEntry[];
}

export interface LogsResponse {
  received_ids: number[];
}

export interface RequestCompleteRequest {
  result: "done" | "failed";
  scan_id?: string;
  message?: string;
}

export interface RequestCompleteResponse {
  id: string;
  status: "done" | "failed";
}
