// Shared agent API contract: JSON Schemas plus compiled validators and TypeScript types.
import Ajv2020, { type ErrorObject } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import scanPayloadSchema from "./scan-payload.v1.schema.json";
import registerRequestSchema from "./agent-api/register.request.schema.json";
import registerResponseSchema from "./agent-api/register.response.schema.json";
import userRequestSchema from "./agent-api/user.request.schema.json";
import scansRequestSchema from "./agent-api/scans.request.schema.json";
import scansResponseSchema from "./agent-api/scans.response.schema.json";

export const schemas = {
  scanPayload: scanPayloadSchema,
  registerRequest: registerRequestSchema,
  registerResponse: registerResponseSchema,
  userRequest: userRequestSchema,
  scansRequest: scansRequestSchema,
  scansResponse: scansResponseSchema,
};

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
ajv.addSchema(scanPayloadSchema);

export const validateScanPayload = ajv.compile<ScanPayload>(scanPayloadSchema);
export const validateRegisterRequest = ajv.compile<RegisterRequest>(registerRequestSchema);
export const validateRegisterResponse = ajv.compile<RegisterResponse>(registerResponseSchema);
export const validateUserRequest = ajv.compile<UserDetails>(userRequestSchema);
export const validateScansRequest = ajv.compile<ScansRequest>(scansRequestSchema);
export const validateScansResponse = ajv.compile<ScansResponse>(scansResponseSchema);

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
