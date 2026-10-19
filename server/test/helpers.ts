import type { RegisterRequest, ScanPayload } from "@pcreader/contracts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { runMigrations } from "@/db/migrate";

export const ENROLLMENT_KEY = "sample-enrollment-key";

const fixtures = join(import.meta.dir, "..", "..", "contracts", "fixtures");
export const loadFixture = <T>(rel: string): T => JSON.parse(readFileSync(join(fixtures, rel), "utf8"));
export const registerFixture = (name: string) => loadFixture<RegisterRequest>(`register/${name}.json`);
export const payloadFixture = (name: string) => loadFixture<ScanPayload>(`payload/${name}.json`);

export async function prepareDatabase(): Promise<void> {
  process.env.DATABASE_URL ??= "postgres://postgres@127.0.0.1:5432/pcreader_test";
  process.env.ENROLLMENT_KEY = ENROLLMENT_KEY;
  await runMigrations();
}

export async function resetDatabase(): Promise<void> {
  await getDb().execute(sql`truncate table status_history, device_field_history, inventory_counters, device_requests, device_logs, network_logs, scans, components, assignments, devices, users restart identity cascade`);
}

export function jsonRequest(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

export function scanBody(payload: ScanPayload, overrides: Partial<{ scan_uuid: string; scan_type: string; collected_at: string }> = {}) {
  return {
    scan_uuid: crypto.randomUUID(),
    scan_type: "manual",
    collected_at: new Date().toISOString(),
    payload,
    ...overrides,
  };
}
