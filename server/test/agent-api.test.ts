import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { validateRegisterResponse, validateScansResponse, type RegisterResponse } from "@pcreader/contracts";
import { and, eq, isNull } from "drizzle-orm";
import { closeDb, getDb } from "@/db";
import { assignments, components, devices, scans, users } from "@/db/schema";
import { handleRegister } from "@/lib/agent/register";
import { handleScan } from "@/lib/agent/scans";
import { hashToken } from "@/lib/tokens";
import { jsonRequest, payloadFixture, prepareDatabase, registerFixture, resetDatabase, scanBody } from "./helpers";

beforeAll(prepareDatabase);
beforeEach(resetDatabase);
afterAll(closeDb);

async function register(name = "windows-desktop", mutate?: (b: ReturnType<typeof registerFixture>) => void) {
  const body = registerFixture(name);
  mutate?.(body);
  const res = await handleRegister(jsonRequest("/api/agent/register", body), getDb());
  return { res, body: (await res.json()) as RegisterResponse };
}

function postScan(token: string | null, body: unknown) {
  return handleScan(jsonRequest("/api/agent/scans", body, token ? { authorization: `Bearer ${token}` } : {}), getDb());
}

const activeComponents = (deviceId: string) =>
  getDb().select().from(components).where(and(eq(components.deviceId, deviceId), isNull(components.removedAt)));

describe("POST /api/agent/register", () => {
  test("creates the user, device and open assignment, returning a token once", async () => {
    const { res, body } = await register();
    expect(res.status).toBe(201);
    expect(validateRegisterResponse(body)).toBe(true);
    expect(body.checkin_interval_seconds).toBe(300);

    const [device] = await getDb().select().from(devices);
    expect(device.id).toBe(body.device_id);
    expect(device.hostname).toBe("AGY-PC-0123");
    expect(device.osType).toBe("windows");
    expect(device.status).toBe("in_use");
    // Only the hash is stored.
    expect(device.tokenHash).toBe(hashToken(body.device_token));
    expect(JSON.stringify(device)).not.toContain(body.device_token);

    const [user] = await getDb().select().from(users);
    expect(user.employeeId).toBe("EMP-0001");
    expect(user.policyAcknowledgedAt).toBeInstanceOf(Date);

    const open = await getDb().select().from(assignments).where(isNull(assignments.endAt));
    expect(open).toHaveLength(1);
    expect(open[0].userId).toBe(user.id);
    expect(open[0].assignedBy).toBe("self-registration");
  });

  test("rejects a wrong enrollment key with 403", async () => {
    const { res } = await register("windows-desktop", (b) => (b.enrollment_key = "wrong"));
    expect(res.status).toBe(403);
    expect(await getDb().select().from(devices)).toHaveLength(0);
  });

  test("returns 503 when the server has no enrollment key configured", async () => {
    const saved = process.env.ENROLLMENT_KEY;
    delete process.env.ENROLLMENT_KEY;
    try {
      const { res } = await register();
      expect(res.status).toBe(503);
    } finally {
      process.env.ENROLLMENT_KEY = saved;
    }
  });

  test("rejects an invalid body with 400 and field details", async () => {
    const res = await handleRegister(jsonRequest("/api/agent/register", { device_uuid: "nope" }), getDb());
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_payload");
    expect(body.details.length).toBeGreaterThan(0);
  });

  test("rejects malformed JSON with 400", async () => {
    const res = await handleRegister(jsonRequest("/api/agent/register", "{not json"), getDb());
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_json");
  });

  test("re-registering rotates the token and keeps the same assignment for the same user", async () => {
    const first = await register();
    const second = await register();
    expect(second.res.status).toBe(201);
    expect(second.body.device_id).toBe(first.body.device_id);
    expect(second.body.device_token).not.toBe(first.body.device_token);

    expect((await postScan(first.body.device_token, scanBody(payloadFixture("windows-desktop")))).status).toBe(401);
    expect((await postScan(second.body.device_token, scanBody(payloadFixture("windows-desktop")))).status).toBe(201);
    expect(await getDb().select().from(assignments)).toHaveLength(1);
  });

  test("registering a device to a different user closes the old assignment", async () => {
    await register();
    await register("windows-desktop", (b) => {
      b.user.employee_id = "EMP-0099";
      b.user.full_name = "Ana Reyes";
    });
    const all = await getDb().select().from(assignments);
    expect(all).toHaveLength(2);
    expect(all.filter((a) => a.endAt === null)).toHaveLength(1);
  });
});

describe("POST /api/agent/scans", () => {
  test("requires a valid bearer token", async () => {
    const body = scanBody(payloadFixture("windows-desktop"));
    expect((await postScan(null, body)).status).toBe(401);
    expect((await postScan("pcr_unknown", body)).status).toBe(401);
  });

  test("stores a Windows scan and its components", async () => {
    const { body: reg } = await register();
    const collectedAt = "2026-10-16T01:00:00.000Z";
    const res = await postScan(reg.device_token, scanBody(payloadFixture("windows-desktop"), { collected_at: collectedAt }));
    expect(res.status).toBe(201);
    const out = await res.json();
    expect(validateScansResponse(out)).toBe(true);

    const [scan] = await getDb().select().from(scans);
    expect(scan.id).toBe(out.scan_id);
    expect(scan.schemaVersion).toBe(1);

    const [device] = await getDb().select().from(devices);
    expect(device.lastFullScanAt?.toISOString()).toBe(collectedAt);
    expect(device.lastSeenAt).toBeInstanceOf(Date);

    const parts = await activeComponents(reg.device_id);
    const count = (c: string) => parts.filter((p) => p.category === c).length;
    expect(count("cpu")).toBe(1);
    expect(count("ram")).toBe(2);
    expect(count("storage")).toBe(2);
    expect(count("motherboard")).toBe(1);
    expect(count("gpu")).toBe(1);
    expect(count("nic")).toBe(2);
    expect(parts.every((p) => !p.isIntegrated || p.category === "gpu")).toBe(true);
  });

  test("Apple Silicon: CPU, memory and SSD are integrated and there is no motherboard", async () => {
    const { body: reg } = await register("macos-apple-silicon");
    expect((await postScan(reg.device_token, scanBody(payloadFixture("macos-apple-silicon")))).status).toBe(201);
    const parts = await activeComponents(reg.device_id);
    for (const cat of ["cpu", "ram", "storage"] as const) {
      const p = parts.filter((x) => x.category === cat);
      expect(p).toHaveLength(1);
      expect(p[0].isIntegrated).toBe(true);
    }
    expect(parts.find((p) => p.category === "motherboard")).toBeUndefined();
    expect(parts.find((p) => p.category === "ram")?.capacityBytes).toBe(17179869184);
  });

  test("Intel Mac payload is accepted for a macOS device", async () => {
    const { body: reg } = await register("macos-apple-silicon");
    expect((await postScan(reg.device_token, scanBody(payloadFixture("macos-intel")))).status).toBe(201);
  });

  test("a duplicate scan_uuid returns 409 with the original scan_id", async () => {
    const { body: reg } = await register();
    const body = scanBody(payloadFixture("windows-desktop"));
    const first = await (await postScan(reg.device_token, body)).json();
    const res = await postScan(reg.device_token, body);
    expect(res.status).toBe(409);
    expect((await res.json()).scan_id).toBe(first.scan_id);
    expect(await getDb().select().from(scans)).toHaveLength(1);
  });

  test("rejects a payload that breaks the schema with 400", async () => {
    const { body: reg } = await register();
    const payload = payloadFixture("windows-desktop") as unknown as Record<string, unknown>;
    delete payload.gpus;
    const res = await postScan(reg.device_token, scanBody(payload as never));
    expect(res.status).toBe(400);
    expect(await getDb().select().from(scans)).toHaveLength(0);
  });

  test("rejects a payload whose os_type differs from the registered device", async () => {
    const { body: reg } = await register();
    expect((await postScan(reg.device_token, scanBody(payloadFixture("macos-apple-silicon")))).status).toBe(400);
  });

  test("rejects a body over the size limit with 413", async () => {
    const { body: reg } = await register();
    const big = JSON.stringify(scanBody(payloadFixture("windows-desktop"))).replace('"agent_version":"0.1.0"', `"agent_version":"${"x".repeat(3_000_000)}"`);
    const res = await postScan(reg.device_token, big);
    expect(res.status).toBe(413);
  });

  test("a removed part gets removed_at and a new part is added", async () => {
    const { body: reg } = await register();
    await postScan(reg.device_token, scanBody(payloadFixture("windows-desktop"), { collected_at: "2026-10-16T01:00:00Z" }));

    const later = payloadFixture("windows-desktop");
    later.storage = later.storage.filter((s) => s.media_type !== "hdd");
    later.memory.modules![1].serial_number = "SAMPLE99";
    expect((await postScan(reg.device_token, scanBody(later, { collected_at: "2026-10-17T01:00:00Z" }))).status).toBe(201);

    const all = await getDb().select().from(components).where(eq(components.deviceId, reg.device_id));
    const removed = all.filter((c) => c.removedAt);
    expect(removed.map((c) => c.serialNumber).sort()).toEqual(["SAMPLE-HDD-0001", "SAMPLE02"]);
    expect(all.find((c) => c.serialNumber === "SAMPLE99")?.removedAt).toBeNull();
    expect((await activeComponents(reg.device_id)).filter((c) => c.category === "ram")).toHaveLength(2);
  });

  test("an older scan arriving late is stored but does not roll components back", async () => {
    const { body: reg } = await register();
    const newer = payloadFixture("windows-desktop");
    newer.storage = newer.storage.filter((s) => s.media_type !== "hdd");
    await postScan(reg.device_token, scanBody(newer, { collected_at: "2026-10-17T01:00:00Z" }));
    expect((await postScan(reg.device_token, scanBody(payloadFixture("windows-desktop"), { collected_at: "2026-10-16T01:00:00Z" }))).status).toBe(201);

    expect(await getDb().select().from(scans)).toHaveLength(2);
    const storage = (await activeComponents(reg.device_id)).filter((c) => c.category === "storage");
    expect(storage).toHaveLength(1);
    const [device] = await getDb().select().from(devices);
    expect(device.lastFullScanAt?.toISOString()).toBe("2026-10-17T01:00:00.000Z");
  });

  test("a revoked token (hash cleared) is rejected", async () => {
    const { body: reg } = await register();
    await getDb().update(devices).set({ tokenHash: null });
    expect((await postScan(reg.device_token, scanBody(payloadFixture("windows-desktop")))).status).toBe(401);
  });
});
