import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { validateEventsMessage, validateMeResponse, validateOkResponse, type RegisterResponse } from "@pcreader/contracts";
import { eq } from "drizzle-orm";
import { closeDb, getDb } from "@/db";
import { devices, serverMoveResults, settingsUnlockAttempts } from "@/db/schema";
import { handleMe, handleMoveResult } from "@/lib/agent/server-move";
import { handleRegister } from "@/lib/agent/register";
import { handleCancelMove, handleMoveStatus, handleStartMove } from "@/lib/dashboard-server-move";
import { pcHashForCurrent } from "@/lib/recovery-key";
import { activeMove, moveForDevice, normalizeMoveUrl } from "@/lib/server-move";
import { auth, jsonRequest, prepareDatabase, registerFixture, resetDatabase, Stream, testPin } from "./helpers";

beforeAll(prepareDatabase);
beforeEach(resetDatabase);
afterAll(closeDb);

const db = () => getDb();

// Registered and holding the current recovery key, so its stream carries only hello and moves.
async function registerDevice(fixture = "windows-desktop"): Promise<{ token: string; deviceId: string }> {
  const res = await handleRegister(jsonRequest("/api/agent/register", registerFixture(fixture)), db());
  const b = (await res.json()) as RegisterResponse;
  const current = await pcHashForCurrent(db());
  await db().update(devices).set({ recoveryKeyVersion: current!.version }).where(eq(devices.id, b.device_id));
  return { token: b.device_token, deviceId: b.device_id };
}

const start = (url: unknown, pin: unknown = testPin(), ip = "10.0.0.9") =>
  handleStartMove(jsonRequest("/api/dashboard/server-move", { url, pin }, { "x-forwarded-for": ip }), db());
const report = (token: string, body: unknown) => handleMoveResult(jsonRequest("/api/agent/move-result", body, auth(token)), db());

describe("addresses", () => {
  test("http(s) with host, port and path; trailing slashes dropped", () => {
    expect(normalizeMoveUrl(" http://pcreader.office.local:3000/ ")).toBe("http://pcreader.office.local:3000");
    expect(normalizeMoveUrl("https://10.0.0.5:8443/pc")).toBe("https://10.0.0.5:8443/pc");
  });
  test("no other schemes, credentials, queries or fragments", () => {
    for (const bad of ["", "ftp://x", "pcreader.local", "http://u:p@host", "http://host/?a=1", "http://host/#x", 42]) {
      expect(() => normalizeMoveUrl(bad)).toThrow();
    }
  });
});

describe("GET /api/agent/me", () => {
  test("names the token's device; 401 for an unknown token", async () => {
    const { token, deviceId } = await registerDevice();
    const res = await handleMe(new Request("http://localhost/api/agent/me", { headers: auth(token) }), db());
    const body = await res.json();
    expect(validateMeResponse(body)).toBe(true);
    expect(body.device_id).toBe(deviceId);
    expect((await handleMe(new Request("http://localhost/api/agent/me", { headers: auth("nope") }), db())).status).toBe(401);
  });
});

describe("starting a move", () => {
  test("needs the current IT PIN (403, then 429), every try recorded", async () => {
    for (let i = 0; i < 5; i++) expect((await start("http://new:3000", "000000")).status).toBe(403);
    expect((await start("http://new:3000")).status).toBe(429);
    expect(await activeMove(db())).toBeNull();
    const attempts = await db().select().from(settingsUnlockAttempts).where(eq(settingsUnlockAttempts.method, "server_move"));
    expect(attempts).toHaveLength(5);
    expect((await start("ftp://new", testPin(), "10.0.0.8")).status).toBe(400);
  });

  test("a new move ends the previous one; cancel ends it", async () => {
    const a = await (await start("http://one:3000")).json();
    const b = await (await start("http://two:3000")).json();
    expect((await activeMove(db()))!.id).toBe(b.id);
    expect(a.id).not.toBe(b.id);
    expect(await (await handleCancelMove(db())).json()).toEqual({ cancelled: true });
    expect(await activeMove(db())).toBeNull();
    expect(await (await handleMoveStatus(db())).json()).toBeNull();
  });
});

describe("telling the PCs", () => {
  test("an open stream gets server_moved at once", async () => {
    const { token } = await registerDevice();
    const s = await Stream.open(token);
    try {
      expect((await s.next()).event).toBe("hello");
      await start("http://pcreader.office.local:3000");
      const m = await s.next();
      expect(validateEventsMessage(m)).toBe(true);
      expect(m).toMatchObject({ event: "server_moved", data: { url: "http://pcreader.office.local:3000" } });
    } finally {
      await s.close();
    }
  });

  test("a PC that was offline during the move gets it when it connects, until it reports that it moved", async () => {
    const { token, deviceId } = await registerDevice();
    const { id } = await (await start("http://new:3000")).json();
    let s = await Stream.open(token);
    try {
      expect((await s.next()).event).toBe("hello");
      expect(await s.next()).toEqual({ event: "server_moved", data: { move_id: id, url: "http://new:3000" } });
    } finally {
      await s.close();
    }
    // It could not reach the new address: told again on the next connect.
    const fail = await report(token, { move_id: id, moved: false, reason: "unreachable" });
    expect(validateOkResponse(await fail.json())).toBe(true);
    expect(await moveForDevice(db(), deviceId)).not.toBeNull();
    const ok = await report(token, { move_id: id, moved: true });
    expect(ok.status).toBe(200);
    expect(await moveForDevice(db(), deviceId)).toBeNull();
    s = await Stream.open(token);
    try {
      expect((await s.next()).event).toBe("hello");
      await expect(s.next(300)).rejects.toThrow(/timed out/);
    } finally {
      await s.close();
    }
  });

  test("a cancelled move is no longer sent", async () => {
    const { token } = await registerDevice();
    await start("http://new:3000");
    await handleCancelMove(db());
    const s = await Stream.open(token);
    try {
      expect((await s.next()).event).toBe("hello");
      await expect(s.next(300)).rejects.toThrow(/timed out/);
    } finally {
      await s.close();
    }
  });
});

describe("results", () => {
  test("per-device status: moved, not moved with reason, waiting", async () => {
    const a = await registerDevice("windows-desktop");
    const b = await registerDevice("macos-apple-silicon");
    const res = await handleRegister(jsonRequest("/api/agent/register", { ...registerFixture("windows-desktop"), device_uuid: crypto.randomUUID() }), db());
    expect(res.status).toBe(201);
    const { id } = await (await start("http://new:3000")).json();
    await report(a.token, { move_id: id, moved: true });
    await report(b.token, { move_id: id, moved: false, reason: "unknown_device" });
    const status = await (await handleMoveStatus(db())).json();
    expect(status).toMatchObject({ url: "http://new:3000", moved: 1, waiting: 1 });
    expect(status.not_moved).toHaveLength(1);
    expect(status.not_moved[0]).toMatchObject({ device_id: b.deviceId, reason: "unknown_device" });
    expect(await db().select().from(serverMoveResults)).toHaveLength(2);
  });

  test("rejects an unknown move (404), a body breaking the contract (400) and a bad token (401)", async () => {
    const { token } = await registerDevice();
    expect((await report(token, { move_id: crypto.randomUUID(), moved: true })).status).toBe(404);
    const { id } = await (await start("http://new:3000")).json();
    expect((await report(token, { move_id: id, moved: false })).status).toBe(400);
    expect((await report(token, { move_id: id, moved: true, reason: "unreachable" })).status).toBe(400);
    expect((await report("nope", { move_id: id, moved: true })).status).toBe(401);
  });
});
