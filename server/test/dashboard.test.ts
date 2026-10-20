import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { RegisterResponse } from "@pcreader/contracts";
import { eq } from "drizzle-orm";
import { closeDb, getDb } from "@/db";
import { deviceLogs, deviceRequests, devices, networkLogs } from "@/db/schema";
import { handleRegister } from "@/lib/agent/register";
import { connectionState, STALE_MS } from "@/lib/format";
import { getDeviceLogs, getLatestRequests, getNetworkHistory, listDevices } from "@/lib/queries";
import { jsonRequest, prepareDatabase, registerFixture, resetDatabase } from "./helpers";

beforeAll(prepareDatabase);
beforeEach(resetDatabase);
afterAll(closeDb);

const now = new Date("2026-10-19T12:00:00Z");
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3600_000);

describe("connectionState", () => {
  test("online while the stream is open, whatever last_seen_at says", () => {
    expect(connectionState({ online: true, lastSeenAt: hoursAgo(500) }, now)).toBe("online");
    expect(connectionState({ online: true, lastSeenAt: null }, now)).toBe("online");
  });
  test("offline until 48 hours, stale after (or never seen)", () => {
    expect(connectionState({ online: false, lastSeenAt: hoursAgo(1) }, now)).toBe("offline");
    expect(connectionState({ online: false, lastSeenAt: new Date(now.getTime() - STALE_MS + 1000) }, now)).toBe("offline");
    expect(connectionState({ online: false, lastSeenAt: new Date(now.getTime() - STALE_MS - 1000) }, now)).toBe("stale");
    expect(connectionState({ online: false, lastSeenAt: null }, now)).toBe("stale");
  });
});

async function registerWith(fixture: string, hostname: string, patch: Partial<typeof devices.$inferInsert>): Promise<string> {
  const body = { ...registerFixture(fixture), device_uuid: crypto.randomUUID(), hostname };
  const res = await handleRegister(jsonRequest("/api/agent/register", { ...body, user: { ...body.user, employee_id: `E-${hostname}` } }), getDb());
  const { device_id } = (await res.json()) as RegisterResponse;
  if (Object.keys(patch).length > 0) await getDb().update(devices).set(patch).where(eq(devices.id, device_id));
  return device_id;
}

describe("listDevices connection filter", () => {
  test("online / offline / stale split the list; no filter returns all", async () => {
    await registerWith("windows-desktop", "A-ONLINE", { online: true, lastSeenAt: hoursAgo(0), agentVersion: "0.3.0" });
    await registerWith("windows-desktop", "B-OFFLINE", { online: false, lastSeenAt: hoursAgo(5) });
    await registerWith("windows-desktop", "C-STALE", { online: false, lastSeenAt: hoursAgo(100) });
    await registerWith("windows-desktop", "D-NEVER", { online: false, lastSeenAt: null });
    const names = async (f?: "online" | "offline" | "stale") => (await listDevices(getDb(), { connection: f }, now)).map((d) => d.hostname);
    expect(await names()).toEqual(["A-ONLINE", "B-OFFLINE", "C-STALE", "D-NEVER"]);
    expect(await names("online")).toEqual(["A-ONLINE"]);
    expect(await names("offline")).toEqual(["B-OFFLINE"]);
    expect(await names("stale")).toEqual(["C-STALE", "D-NEVER"]);
    const [first] = await listDevices(getDb(), { connection: "online" }, now);
    expect(first).toMatchObject({ online: true, agentVersion: "0.3.0" });
  });
});

describe("device detail queries", () => {
  test("latest request per type", async () => {
    const id = await registerWith("windows-desktop", "PC", {});
    const db = getDb();
    await db.insert(deviceRequests).values({ deviceId: id, type: "scan_now", status: "done", createdAt: hoursAgo(3) });
    await db.insert(deviceRequests).values({ deviceId: id, type: "scan_now", status: "pending", createdAt: hoursAgo(1) });
    await db.insert(deviceRequests).values({ deviceId: id, type: "send_logs", status: "failed", createdAt: hoursAgo(2), message: "x" });
    const latest = await getLatestRequests(db, id);
    expect(latest.get("scan_now")?.status).toBe("pending");
    expect(latest.get("send_logs")?.status).toBe("failed");
    expect(latest.has("prompt_details_update")).toBe(false);
  });

  test("logs newest first with a level filter; network history newest first", async () => {
    const id = await registerWith("windows-desktop", "PC", {});
    const db = getDb();
    await db.insert(deviceLogs).values([
      { deviceId: id, localEntryId: 1, loggedAt: hoursAgo(3), level: "info", category: "system", message: "old info" },
      { deviceId: id, localEntryId: 2, loggedAt: hoursAgo(2), level: "error", category: "scan", message: "an error" },
      { deviceId: id, localEntryId: 3, loggedAt: hoursAgo(1), level: "info", category: "sync", message: "new info" },
    ]);
    expect((await getDeviceLogs(db, id)).map((l) => l.message)).toEqual(["new info", "an error", "old info"]);
    expect((await getDeviceLogs(db, id, "error")).map((l) => l.message)).toEqual(["an error"]);
    const snap = { ipAddresses: ["1.1.1.1"], macAddresses: [], dnsServers: [], connectionType: "wifi" as const };
    await db.insert(networkLogs).values([
      { deviceId: id, collectedAt: hoursAgo(5), ...snap, ssid: "OLD" },
      { deviceId: id, collectedAt: hoursAgo(1), ...snap, ssid: "NEW" },
    ]);
    expect((await getNetworkHistory(db, id)).map((n) => n.ssid)).toEqual(["NEW", "OLD"]);
  });
});
