import type { RegisterRequest, ScanPayload } from "@pcreader/contracts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { handleEvents } from "@/lib/agent/events";
import { runMigrations } from "@/db/migrate";
import { derivePin } from "@/lib/it-pin";
import { pcHashSettings } from "@/lib/recovery-key";

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
  process.env.SECRETS_KEY ??= Buffer.alloc(32, 7).toString("base64");
  // The lowest work factor the contract allows, so tests that rotate keys stay fast.
  pcHashSettings.iterations = 100_000;
  await runMigrations();
}

export async function resetDatabase(): Promise<void> {
  await getDb().execute(sql`truncate table server_move_results, server_moves, recovery_key_access_log, recovery_keys, secret_access_log, device_field_values, custom_fields, app_settings, settings_unlock_attempts, it_pin_state, status_history, device_field_history, inventory_counters, device_requests, device_logs, network_logs, scans, components, assignments, devices, users restart identity cascade`);
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

export const auth = (token: string) => ({ authorization: `Bearer ${token}` });

// Reads the SSE stream frame by frame.
export class Stream {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private buffer = "";
  private decoder = new TextDecoder();
  readonly abort = new AbortController();

  private constructor(readonly response: Response) {
    this.reader = response.body!.getReader();
  }

  static async open(token: string | null, version = "0.3.0-test"): Promise<Stream> {
    const abort = new AbortController();
    const req = new Request(`http://localhost/api/agent/events?agent_version=${encodeURIComponent(version)}`, {
      headers: token ? auth(token) : {},
      signal: abort.signal,
    });
    const s = new Stream(await handleEvents(req, getDb()));
    (s as { abort: AbortController }).abort = abort;
    return s;
  }

  async next(timeoutMs = 3000): Promise<{ event: string; data: unknown }> {
    for (;;) {
      const end = this.buffer.indexOf("\n\n");
      if (end >= 0) {
        const raw = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 2);
        if (raw.startsWith(":")) continue;
        const event = /^event: (.*)$/m.exec(raw)![1];
        const data = JSON.parse(/^data: (.*)$/m.exec(raw)![1]);
        return { event, data };
      }
      const chunk = await Promise.race([
        this.reader.read(),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timed out waiting for an event")), timeoutMs)),
      ]);
      if (chunk.done) throw new Error("stream closed");
      this.buffer += this.decoder.decode(chunk.value);
    }
  }

  async close() {
    this.abort.abort();
    await this.reader.cancel().catch(() => {});
  }
}
