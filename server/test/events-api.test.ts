import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  MAX_LOG_BATCH,
  validateEventsMessage,
  validateLogsResponse,
  validateRequestCompleteResponse,
  type LogEntry,
  type NetworkSnapshot,
  type RegisterResponse,
} from "@pcreader/contracts";
import { asc, eq } from "drizzle-orm";
import { closeDb, getDb } from "@/db";
import { deviceLogs, deviceRequests, devices, networkLogs, scans } from "@/db/schema";
import { handleRegister } from "@/lib/agent/register";
import { handleScan } from "@/lib/agent/scans";
import { handleEvents, resetOnlineFlags } from "@/lib/agent/events";
import { handleLogs } from "@/lib/agent/logs";
import { handleNetwork } from "@/lib/agent/network";
import { handleRequestComplete } from "@/lib/agent/complete";
import { handleQueueRequest } from "@/lib/dashboard-requests";
import { queueRequest } from "@/lib/requests";
import { jsonRequest, loadFixture, payloadFixture, prepareDatabase, registerFixture, resetDatabase, scanBody } from "./helpers";

beforeAll(prepareDatabase);
beforeEach(resetDatabase);
afterAll(closeDb);

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function registerDevice(fixture = "windows-desktop"): Promise<{ token: string; deviceId: string }> {
  const res = await handleRegister(jsonRequest("/api/agent/register", registerFixture(fixture)), getDb());
  const body = (await res.json()) as RegisterResponse;
  return { token: body.device_token, deviceId: body.device_id };
}

// Reads the SSE stream frame by frame.
class Stream {
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

const getDevice = async (id: string) => (await getDb().select().from(devices).where(eq(devices.id, id)))[0];
const settle = () => new Promise((r) => setTimeout(r, 50));

describe("GET /api/agent/events", () => {
  test("rejects a missing or unknown token with 401", async () => {
    await registerDevice();
    expect((await Stream.open(null)).response.status).toBe(401);
    expect((await Stream.open("not-a-token")).response.status).toBe(401);
  });

  test("rejects a missing agent_version with 400", async () => {
    const { token } = await registerDevice();
    const res = await handleEvents(new Request("http://localhost/api/agent/events", { headers: auth(token) }), getDb());
    expect(res.status).toBe(400);
  });

  test("opens as a text/event-stream, says hello, and marks the device online with its version", async () => {
    const { token, deviceId } = await registerDevice();
    const s = await Stream.open(token, "0.3.0+abc1234");
    expect(s.response.status).toBe(200);
    expect(s.response.headers.get("content-type")).toContain("text/event-stream");
    const hello = await s.next();
    expect(validateEventsMessage(hello)).toBe(true);
    expect(hello.event).toBe("hello");
    const d = await getDevice(deviceId);
    expect(d.online).toBe(true);
    expect(d.agentVersion).toBe("0.3.0+abc1234");
    expect(d.connectedAt).toBeInstanceOf(Date);
    await s.close();
  });

  test("sends every pending request on connect and marks them delivered", async () => {
    const { token, deviceId } = await registerDevice();
    await queueRequest(getDb(), deviceId, "scan_now");
    await queueRequest(getDb(), deviceId, "send_logs");
    const s = await Stream.open(token);
    await s.next(); // hello
    const a = await s.next();
    const b = await s.next();
    expect(validateEventsMessage(a)).toBe(true);
    expect([(a.data as { type: string }).type, (b.data as { type: string }).type]).toEqual(["scan_now", "send_logs"]);
    const rows = await getDb().select().from(deviceRequests).orderBy(asc(deviceRequests.createdAt));
    expect(rows.map((r) => r.status)).toEqual(["delivered", "delivered"]);
    expect(rows[0].deliveredAt).toBeInstanceOf(Date);
    await s.close();
  });

  test("pushes a request queued while connected", async () => {
    const { token, deviceId } = await registerDevice();
    const s = await Stream.open(token);
    await s.next(); // hello
    const queued = await queueRequest(getDb(), deviceId, "scan_now");
    const msg = await s.next();
    expect(msg.event).toBe("request");
    expect(msg.data).toMatchObject({ id: queued!.request.id, type: "scan_now" });
    expect((await getDb().select().from(deviceRequests))[0].status).toBe("delivered");
    await s.close();
  });

  test("sends a delivered but unfinished request again on reconnect", async () => {
    const { token, deviceId } = await registerDevice();
    const queued = await queueRequest(getDb(), deviceId, "scan_now");
    const first = await Stream.open(token);
    await first.next();
    await first.next();
    await first.close();
    await settle();
    const second = await Stream.open(token);
    await second.next();
    expect((await second.next()).data).toMatchObject({ id: queued!.request.id });
    await second.close();
  });

  test("closing the stream marks the device offline and records last_seen_at", async () => {
    const { token, deviceId } = await registerDevice();
    const s = await Stream.open(token);
    await s.next();
    expect((await getDevice(deviceId)).online).toBe(true);
    const before = (await getDevice(deviceId)).lastSeenAt!;
    await Bun.sleep(10);
    await s.close();
    await settle();
    const d = await getDevice(deviceId);
    expect(d.online).toBe(false);
    expect(d.connectionId).toBeNull();
    expect(d.lastSeenAt!.getTime()).toBeGreaterThan(before.getTime());
  });

  test("a reconnect replaces the old stream, which closing later does not flip the device offline", async () => {
    const { token, deviceId } = await registerDevice();
    const old = await Stream.open(token);
    await old.next();
    const fresh = await Stream.open(token);
    await fresh.next();
    await old.close();
    await settle();
    expect((await getDevice(deviceId)).online).toBe(true);
    await fresh.close();
    await settle();
    expect((await getDevice(deviceId)).online).toBe(false);
  });

  test("resetOnlineFlags clears flags left by a previous server process", async () => {
    const { deviceId } = await registerDevice();
    await getDb().update(devices).set({ online: true, connectionId: crypto.randomUUID() }).where(eq(devices.id, deviceId));
    await resetOnlineFlags(getDb());
    expect((await getDevice(deviceId)).online).toBe(false);
  });
});

describe("dashboard request queueing", () => {
  const post = (deviceId: string, body: unknown) => handleQueueRequest(jsonRequest(`/api/dashboard/devices/${deviceId}/requests`, body), getDb(), deviceId);

  test("queues a request (201) and returns the existing open one when pressed again (200)", async () => {
    const { deviceId } = await registerDevice();
    const first = await post(deviceId, { type: "scan_now" });
    expect(first.status).toBe(201);
    const firstBody = await first.json();
    const again = await post(deviceId, { type: "scan_now" });
    expect(again.status).toBe(200);
    expect((await again.json()).id).toBe(firstBody.id);
    expect((await post(deviceId, { type: "send_logs" })).status).toBe(201);
    const rows = await getDb().select().from(deviceRequests);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.requestedBy === null && r.status === "pending")).toBe(true);
  });

  test("a finished request does not block a new one of the same type", async () => {
    const { deviceId } = await registerDevice();
    const first = await queueRequest(getDb(), deviceId, "scan_now");
    await getDb().update(deviceRequests).set({ status: "done" }).where(eq(deviceRequests.id, first!.request.id));
    const second = await post(deviceId, { type: "scan_now" });
    expect(second.status).toBe(201);
  });

  test("rejects an unknown type (400) and an unknown device (404)", async () => {
    const { deviceId } = await registerDevice();
    expect((await post(deviceId, { type: "reboot" })).status).toBe(400);
    expect((await post(crypto.randomUUID(), { type: "scan_now" })).status).toBe(404);
    expect((await post("not-a-uuid", { type: "scan_now" })).status).toBe(404);
  });
});

describe("POST /api/agent/requests/{id}/complete", () => {
  const complete = (token: string | null, id: string, body: unknown) =>
    handleRequestComplete(jsonRequest(`/api/agent/requests/${id}/complete`, body, token ? auth(token) : {}), getDb(), id);

  async function uploadScan(token: string): Promise<string> {
    const res = await handleScan(jsonRequest("/api/agent/scans", scanBody(payloadFixture("windows-desktop"), { scan_type: "on_demand" }), auth(token)), getDb());
    return ((await res.json()) as { scan_id: string }).scan_id;
  }

  test("marks a delivered request done with its scan, idempotently", async () => {
    const { token, deviceId } = await registerDevice();
    const { request } = (await queueRequest(getDb(), deviceId, "scan_now"))!;
    await getDb().update(deviceRequests).set({ status: "delivered" }).where(eq(deviceRequests.id, request.id));
    const scanId = await uploadScan(token);

    const res = await complete(token, request.id, { result: "done", scan_id: scanId });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(validateRequestCompleteResponse(body)).toBe(true);
    expect(body).toEqual({ id: request.id, status: "done" });
    const [row] = await getDb().select().from(deviceRequests);
    expect(row.status).toBe("done");
    expect(row.scanId).toBe(scanId);
    expect(row.completedAt).toBeInstanceOf(Date);

    // Completing again (even as failed) keeps the first outcome.
    const again = await complete(token, request.id, { result: "failed", message: "late" });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ id: request.id, status: "done" });
    expect((await getDb().select().from(deviceRequests))[0].message).toBeNull();
  });

  test("records a failure message", async () => {
    const { token, deviceId } = await registerDevice();
    const { request } = (await queueRequest(getDb(), deviceId, "send_logs"))!;
    expect((await complete(token, request.id, { result: "failed", message: "Upload failed" })).status).toBe(200);
    const [row] = await getDb().select().from(deviceRequests);
    expect(row).toMatchObject({ status: "failed", message: "Upload failed" });
  });

  test("only the owning device can complete a request (404 otherwise)", async () => {
    const a = await registerDevice("windows-desktop");
    const other = registerFixture("macos-apple-silicon");
    const bRes = await handleRegister(jsonRequest("/api/agent/register", other), getDb());
    const b = (await bRes.json()) as RegisterResponse;
    const { request } = (await queueRequest(getDb(), a.deviceId, "scan_now"))!;
    expect((await complete(b.device_token, request.id, { result: "done" })).status).toBe(404);
    expect((await complete(a.token, crypto.randomUUID(), { result: "done" })).status).toBe(404);
    expect((await getDb().select().from(deviceRequests))[0].status).toBe("pending");
  });

  test("rejects a scan_id from another device, an invalid body, and a bad token", async () => {
    const { token, deviceId } = await registerDevice();
    const { request } = (await queueRequest(getDb(), deviceId, "scan_now"))!;
    expect((await complete(token, request.id, { result: "done", scan_id: crypto.randomUUID() })).status).toBe(400);
    expect((await complete(token, request.id, { result: "maybe" })).status).toBe(400);
    expect((await complete(null, request.id, { result: "done" })).status).toBe(401);
    expect((await complete("nope", request.id, { result: "done" })).status).toBe(401);
  });
});

describe("POST /api/agent/logs", () => {
  const post = (token: string | null, body: unknown) =>
    handleLogs(jsonRequest("/api/agent/logs", body, token ? auth(token) : {}), getDb());
  const entry = (id: number, over: Partial<LogEntry> = {}): LogEntry => ({
    local_entry_id: id,
    logged_at: "2026-10-19T08:00:00Z",
    level: "info",
    category: "system",
    message: `entry ${id}`,
    ...over,
  });

  test("stores entries and returns their ids", async () => {
    const { token } = await registerDevice();
    const res = await post(token, loadFixture("logs/request.json"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(validateLogsResponse(body)).toBe(true);
    expect(body.received_ids).toEqual([41, 42, 43]);
    expect(await getDb().select().from(deviceLogs)).toHaveLength(3);
  });

  test("dedupes on (device, local_entry_id) and still reports duplicates as received", async () => {
    const { token } = await registerDevice();
    await post(token, { entries: [entry(1), entry(2)] });
    const res = await post(token, { entries: [entry(2, { message: "changed" }), entry(3), entry(3)] });
    expect((await res.json()).received_ids).toEqual([2, 3]);
    const rows = await getDb().select().from(deviceLogs).orderBy(asc(deviceLogs.localEntryId));
    expect(rows.map((r) => [r.localEntryId, r.message])).toEqual([
      [1, "entry 1"],
      [2, "entry 2"],
      [3, "entry 3"],
    ]);
  });

  test("two devices may use the same local_entry_id", async () => {
    const a = await registerDevice("windows-desktop");
    const bRes = await handleRegister(jsonRequest("/api/agent/register", registerFixture("macos-apple-silicon")), getDb());
    const b = (await bRes.json()) as RegisterResponse;
    await post(a.token, { entries: [entry(1)] });
    await post(b.device_token, { entries: [entry(1)] });
    expect(await getDb().select().from(deviceLogs)).toHaveLength(2);
  });

  test("accepts 500 entries and rejects 501 with 413", async () => {
    const { token } = await registerDevice();
    const ok = await post(token, { entries: Array.from({ length: MAX_LOG_BATCH }, (_, i) => entry(i + 1)) });
    expect(ok.status).toBe(200);
    expect((await ok.json()).received_ids).toHaveLength(500);
    const big = await post(token, { entries: Array.from({ length: MAX_LOG_BATCH + 1 }, (_, i) => entry(i + 1000)) });
    expect(big.status).toBe(413);
    expect((await big.json()).error).toBe("payload_too_large");
    expect(await getDb().select().from(deviceLogs)).toHaveLength(500);
  });

  test("rejects invalid entries with 400 and a bad token with 401", async () => {
    const { token } = await registerDevice();
    expect((await post(token, { entries: [entry(1, { level: "debug" as never })] })).status).toBe(400);
    expect((await post(token, { entries: [] })).status).toBe(400);
    expect((await post(null, { entries: [entry(1)] })).status).toBe(401);
    expect((await post("nope", { entries: [entry(1)] })).status).toBe(401);
  });
});

describe("POST /api/agent/network", () => {
  const post = (token: string | null, body: unknown) =>
    handleNetwork(jsonRequest("/api/agent/network", body, token ? auth(token) : {}), getDb());

  test("stores each snapshot", async () => {
    const { token, deviceId } = await registerDevice();
    expect((await post(token, loadFixture<NetworkSnapshot>("network/wifi.json"))).status).toBe(204);
    expect((await post(token, loadFixture<NetworkSnapshot>("network/ethernet.json"))).status).toBe(204);
    const rows = await getDb().select().from(networkLogs).where(eq(networkLogs.deviceId, deviceId)).orderBy(asc(networkLogs.collectedAt));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      connectionType: "wifi",
      ssid: "SAMPLE-AGENCY-WIFI",
      gateway: "192.168.1.1",
      ipAddresses: ["192.168.1.57", "2001:db8:1::57"],
      macAddresses: ["D0:8E:79:00:00:02"],
      dnsServers: ["192.168.1.1", "8.8.8.8"],
      online: true,
    });
    expect(rows[1]).toMatchObject({ connectionType: "ethernet", ssid: null });
  });

  test("rejects an invalid snapshot with 400 and a bad token with 401", async () => {
    const { token } = await registerDevice();
    expect((await post(token, { ...loadFixture<NetworkSnapshot>("network/wifi.json"), connection_type: "cellular" })).status).toBe(400);
    expect((await post(null, loadFixture("network/wifi.json"))).status).toBe(401);
    expect((await post("nope", loadFixture("network/wifi.json"))).status).toBe(401);
  });
});

describe("last_seen_at", () => {
  test("any authenticated agent call refreshes it", async () => {
    const { token, deviceId } = await registerDevice();
    await getDb().update(devices).set({ lastSeenAt: new Date("2026-01-01T00:00:00Z") }).where(eq(devices.id, deviceId));
    await handleNetwork(jsonRequest("/api/agent/network", loadFixture("network/wifi.json"), auth(token)), getDb());
    expect((await getDevice(deviceId)).lastSeenAt!.getFullYear()).toBeGreaterThanOrEqual(2026);
    expect((await getDevice(deviceId)).lastSeenAt!.getTime()).toBeGreaterThan(new Date("2026-06-01T00:00:00Z").getTime());
    expect(await getDb().select().from(scans)).toHaveLength(0);
  });
});
