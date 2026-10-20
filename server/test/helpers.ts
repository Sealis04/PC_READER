import type { RegisterRequest, ScanPayload } from "@pcreader/contracts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { runMigrations } from "@/db/migrate";
import { derivePin } from "@/lib/it-pin";

export const ENROLLMENT_KEY = "sample-enrollment-key";
export const TEST_PIN_SECRET = "test-it-pin-secret";

// The current IT PIN with the test secret (generation 0, i.e. before any "Change now").
export const testPin = (now = new Date()): string => derivePin(TEST_PIN_SECRET, 0, now);

const fixtures = join(import.meta.dir, "..", "..", "contracts", "fixtures");
export const loadFixture = <T>(rel: string): T => JSON.parse(readFileSync(join(fixtures, rel), "utf8"));
export const registerFixture = (name: string): RegisterRequest => ({ ...loadFixture<RegisterRequest>(`register/${name}.json`), it_pin: testPin() });
export const payloadFixture = (name: string) => loadFixture<ScanPayload>(`payload/${name}.json`);

export async function prepareDatabase(): Promise<void> {
  process.env.DATABASE_URL ??= "postgres://postgres@127.0.0.1:5432/pcreader_test";
  process.env.ENROLLMENT_KEY = ENROLLMENT_KEY;
  process.env.IT_PIN_SECRET = TEST_PIN_SECRET;
  await runMigrations();
}

export async function resetDatabase(): Promise<void> {
  await getDb().execute(sql`truncate table settings_unlock_attempts, it_pin_state, status_history, device_field_history, inventory_counters, device_requests, device_logs, network_logs, scans, components, assignments, devices, users restart identity cascade`);
}

export function jsonRequest(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

export function scanBody(payload: ScanPayload, overrides: Partial<{ scan_uuid: string; scan_type: string; collected_at: string; it_pin: string }> = {}) {
  const scan_type = overrides.scan_type ?? "manual";
  return {
    scan_uuid: crypto.randomUUID(),
    scan_type,
    collected_at: new Date().toISOString(),
    // Manual scans (Report now) need the PIN; the other types are sent without one.
    ...(scan_type === "manual" && { it_pin: testPin() }),
    payload,
    ...overrides,
  };
}
