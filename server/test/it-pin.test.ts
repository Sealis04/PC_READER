import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { validateSettingsUnlockResponse, type RegisterResponse } from "@pcreader/contracts";
import { asc, sql } from "drizzle-orm";
import { closeDb, getDb } from "@/db";
import { settingsUnlockAttempts } from "@/db/schema";
import { handleRegister } from "@/lib/agent/register";
import { handleSettingsUnlock } from "@/lib/agent/settings-unlock";
import { currentPin, expiresAt, MAX_WRONG_PER_WINDOW, rotateNow, verifyPin } from "@/lib/it-pin";
import { handleScan } from "@/lib/agent/scans";
import { handleUserUpdate } from "@/lib/agent/user";
import { jsonRequest, loadFixture, payloadFixture, prepareDatabase, registerFixture, resetDatabase, scanBody, testPin } from "./helpers";

beforeAll(prepareDatabase);
beforeEach(resetDatabase);
afterAll(closeDb);

// Asia/Manila is UTC+8 with no DST: 15:00 PHT is 07:00Z.
const at = (iso: string) => new Date(iso);
const notPin = (pin: string) => (pin === "000000" ? "000001" : "000000");

async function registerDevice(): Promise<{ token: string; deviceId: string }> {
  const res = await handleRegister(jsonRequest("/api/agent/register", registerFixture("windows-desktop")), getDb());
  const body = (await res.json()) as RegisterResponse;
  await getDb().delete(settingsUnlockAttempts); // forget the signup's own PIN attempt
  return { token: body.device_token, deviceId: body.device_id };
}

const unlock = (token: string | null, body: unknown) =>
  handleSettingsUnlock(jsonRequest("/api/agent/settings-unlock", body, token ? { authorization: `Bearer ${token}` } : {}), getDb());

describe("hourly IT PIN", () => {
  test("is six digits and the same for the whole hour in Asia/Manila", async () => {
    const db = getDb();
    const a = await currentPin(db, at("2026-10-20T07:00:00.000Z")); // 15:00:00 PHT
    const b = await currentPin(db, at("2026-10-20T07:59:59.999Z")); // 15:59:59 PHT
    expect(a.pin).toMatch(/^[0-9]{6}$/);
    expect(b.pin).toBe(a.pin);
  });

  test("changes at the top of the hour in Asia/Manila", async () => {
    const db = getDb();
    const before = await currentPin(db, at("2026-10-20T06:59:59.999Z")); // 14:59:59 PHT
    const after = await currentPin(db, at("2026-10-20T07:00:00.000Z")); // 15:00:00 PHT
    expect(after.pin).not.toBe(before.pin);
  });

  test("expiresAt is the next local top of the hour", () => {
    expect(expiresAt(at("2026-10-20T07:12:34.500Z")).toISOString()).toBe("2026-10-20T08:00:00.000Z");
    expect(expiresAt(at("2026-10-20T07:00:00.000Z")).toISOString()).toBe("2026-10-20T08:00:00.000Z");
    expect(expiresAt(at("2026-10-20T07:59:59.999Z")).toISOString()).toBe("2026-10-20T08:00:00.000Z");
  });

  test("stays the same across calls (the secret is stored), and Change now replaces it", async () => {
    const db = getDb();
    const now = at("2026-10-20T07:30:00.000Z");
    const first = await currentPin(db, now);
    expect((await currentPin(db, now)).pin).toBe(first.pin);
    const rotated = await rotateNow(db, now);
    expect(rotated.pin).not.toBe(first.pin);
    expect((await currentPin(db, now)).pin).toBe(rotated.pin);
    // The next hour still rotates normally.
    expect((await currentPin(db, at("2026-10-20T08:00:00.000Z"))).pin).not.toBe(rotated.pin);
  });

  test("IT_PIN_SECRET replaces the stored secret", async () => {
    const db = getDb();
    const now = at("2026-10-20T07:30:00.000Z");
    const before = process.env.IT_PIN_SECRET;
    delete process.env.IT_PIN_SECRET; // the test setup sets one; look at the stored secret instead
    try {
      const stored = await currentPin(db, now);
      process.env.IT_PIN_SECRET = "fixed-secret-for-tests";
      const a = await currentPin(db, now);
      expect(a.pin).not.toBe(stored.pin);
      expect((await currentPin(db, now)).pin).toBe(a.pin);
    } finally {
      process.env.IT_PIN_SECRET = before;
    }
  });
});

describe("verifyPin", () => {
  test("accepts the current PIN, rejects a wrong or old one, and records each attempt", async () => {
    const db = getDb();
    const { deviceId } = await registerDevice();
    const now = at("2026-10-20T07:30:00.000Z");
    const { pin } = await currentPin(db, now);
    const old = (await currentPin(db, at("2026-10-20T06:30:00.000Z"))).pin;

    expect(await verifyPin(db, deviceId, notPin(pin), "hourly_pin", now)).toBe("wrong_pin");
    expect(await verifyPin(db, deviceId, old, "hourly_pin", now)).toBe("wrong_pin");
    expect(await verifyPin(db, deviceId, pin, "hourly_pin", now)).toBe("ok");

    const rows = await db.select().from(settingsUnlockAttempts).orderBy(asc(settingsUnlockAttempts.createdAt));
    expect(rows.map((r) => r.success)).toEqual([false, false, true]);
    expect(rows.every((r) => r.deviceId === deviceId && r.method === "hourly_pin")).toBe(true);
  });

  test("a PIN stops working after Change now", async () => {
    const db = getDb();
    const { deviceId } = await registerDevice();
    const now = at("2026-10-20T07:30:00.000Z");
    const { pin } = await currentPin(db, now);
    await rotateNow(db, now);
    expect(await verifyPin(db, deviceId, pin, "hourly_pin", now)).toBe("wrong_pin");
  });

  test("refuses a device after too many wrong tries in a minute, until they age out", async () => {
    const db = getDb();
    const { deviceId } = await registerDevice();
    const now = at("2026-10-20T07:30:00.000Z");
    const { pin } = await currentPin(db, now);
    for (let i = 0; i < MAX_WRONG_PER_WINDOW; i++) expect(await verifyPin(db, deviceId, notPin(pin), "hourly_pin", now)).toBe("wrong_pin");
    // Even the right PIN is refused while rate limited, and refusals are not recorded.
    expect(await verifyPin(db, deviceId, pin, "hourly_pin", now)).toBe("too_many_attempts");
    expect(await db.select().from(settingsUnlockAttempts)).toHaveLength(MAX_WRONG_PER_WINDOW);
    expect(await verifyPin(db, deviceId, pin, "hourly_pin", at("2026-10-20T07:30:30.000Z"))).toBe("too_many_attempts");
    expect(await verifyPin(db, deviceId, pin, "hourly_pin", at("2026-10-20T07:31:01.000Z"))).toBe("ok");
  });
});

describe("POST /api/agent/settings-unlock", () => {
  test("200 { ok: true } for the current PIN", async () => {
    const { token } = await registerDevice();
    const { pin } = await currentPin(getDb());
    const res = await unlock(token, { pin });
    expect(res.status).toBe(200);
    expect(validateSettingsUnlockResponse(await res.json())).toBe(true);
  });

  test("403 wrong_pin for another PIN", async () => {
    const { token } = await registerDevice();
    const { pin } = await currentPin(getDb());
    const res = await unlock(token, { pin: notPin(pin) });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "wrong_pin" });
  });

  test("429 too_many_attempts after five wrong PINs", async () => {
    const { token } = await registerDevice();
    const { pin } = await currentPin(getDb());
    for (let i = 0; i < MAX_WRONG_PER_WINDOW; i++) expect((await unlock(token, { pin: notPin(pin) })).status).toBe(403);
    const res = await unlock(token, { pin });
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: "too_many_attempts" });
  });

  test("401 without a valid device token, and nothing is recorded", async () => {
    await registerDevice();
    expect((await unlock(null, { pin: "123456" })).status).toBe(401);
    expect((await unlock("not-a-token", { pin: "123456" })).status).toBe(401);
    expect(await getDb().select().from(settingsUnlockAttempts)).toHaveLength(0);
  });

  test("400 for a malformed PIN, and nothing is recorded", async () => {
    const { token } = await registerDevice();
    for (const body of [{ pin: "12345" }, { pin: "abcdef" }, { pin: 123456 }, {}, { pin: "123456", extra: true }]) {
      expect((await unlock(token, body)).status).toBe(400);
    }
    expect(await getDb().select().from(settingsUnlockAttempts)).toHaveLength(0);
  });
});

const wrongPin = () => notPin(testPin());
const register = (body: unknown, ip?: string) =>
  handleRegister(jsonRequest("/api/agent/register", body, ip ? { "x-forwarded-for": ip } : {}), getDb());
const putUser = (token: string, body: unknown) =>
  handleUserUpdate(new Request(jsonRequest("/api/agent/user", body, { authorization: `Bearer ${token}` }), { method: "PUT" }), getDb());
const postScan = (token: string, body: unknown) =>
  handleScan(jsonRequest("/api/agent/scans", body, { authorization: `Bearer ${token}` }), getDb());
const userBody = (pin?: string) => ({ ...loadFixture<Record<string, unknown>>("user/windows-desktop.json"), it_pin: pin ?? testPin() });

describe("POST /api/agent/register needs the IT PIN", () => {
  test("201 with the current PIN, and the attempt is recorded with no device", async () => {
    const res = await register(registerFixture("windows-desktop"), "10.0.0.7");
    expect(res.status).toBe(201);
    const [row] = await getDb().select().from(settingsUnlockAttempts);
    expect(row).toMatchObject({ deviceId: null, clientIp: "10.0.0.7", success: true, method: "register" });
  });

  test("403 wrong_pin for a wrong PIN, and no device or user is created", async () => {
    const res = await register({ ...registerFixture("windows-desktop"), it_pin: wrongPin() });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "wrong_pin" });
    const [row] = await getDb().select().from(settingsUnlockAttempts);
    expect(row).toMatchObject({ success: false, method: "register" });
    expect((await getDb().execute(sql`select count(*)::int as n from devices`))[0]).toMatchObject({ n: 0 });
  });

  test("400 when the PIN is missing or malformed", async () => {
    const without: Record<string, unknown> = { ...registerFixture("windows-desktop") };
    delete without.it_pin;
    expect((await register(without)).status).toBe(400);
    expect((await register({ ...registerFixture("windows-desktop"), it_pin: "12345" })).status).toBe(400);
    expect(await getDb().select().from(settingsUnlockAttempts)).toHaveLength(0);
  });

  test("the enrollment key is checked first: a bad key is 403 invalid_enrollment_key and records no attempt", async () => {
    const res = await register({ ...registerFixture("windows-desktop"), enrollment_key: "nope", it_pin: wrongPin() });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "invalid_enrollment_key" });
    expect(await getDb().select().from(settingsUnlockAttempts)).toHaveLength(0);
  });

  test("429 after five wrong PINs from one IP; another IP is unaffected", async () => {
    const bad = { ...registerFixture("windows-desktop"), it_pin: wrongPin() };
    for (let i = 0; i < MAX_WRONG_PER_WINDOW; i++) expect((await register(bad, "10.0.0.7")).status).toBe(403);
    const blocked = await register(registerFixture("windows-desktop"), "10.0.0.7");
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toMatchObject({ error: "too_many_attempts" });
    expect((await register(registerFixture("windows-desktop"), "10.0.0.8")).status).toBe(201);
  });
});

describe("PUT /api/agent/user needs the IT PIN", () => {
  test("200 with the current PIN; the PIN is not echoed back; the attempt is recorded", async () => {
    const { token, deviceId } = await registerDevice();
    const res = await putUser(token, userBody());
    expect(res.status).toBe(200);
    expect(await res.json()).not.toHaveProperty("it_pin");
    const rows = await getDb().select().from(settingsUnlockAttempts).where(sql`method = 'update_details'`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ deviceId, success: true });
  });

  test("403 wrong_pin and nothing changes", async () => {
    const { token } = await registerDevice();
    const res = await putUser(token, { ...userBody(wrongPin()), full_name: "Changed Name" });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "wrong_pin" });
    expect((await getDb().execute(sql`select full_name from users`))[0]).toMatchObject({ full_name: "Juan Dela Cruz" });
  });

  test("400 without a PIN (also while the dashboard asked to confirm the details)", async () => {
    const { token, deviceId } = await registerDevice();
    await getDb().execute(sql`insert into device_requests (device_id, type, status) values (${deviceId}, 'prompt_details_update', 'delivered')`);
    const without = userBody() as Record<string, unknown>;
    delete without.it_pin;
    expect((await putUser(token, without)).status).toBe(400);
    expect((await putUser(token, userBody(wrongPin()))).status).toBe(403);
  });

  test("429 after five wrong PINs on one device, shared with Settings", async () => {
    const { token } = await registerDevice();
    for (let i = 0; i < 3; i++) expect((await unlock(token, { pin: wrongPin() })).status).toBe(403);
    for (let i = 0; i < 2; i++) expect((await putUser(token, userBody(wrongPin()))).status).toBe(403);
    expect((await putUser(token, userBody())).status).toBe(429);
    expect((await unlock(token, { pin: testPin() })).status).toBe(429);
  });
});

describe("POST /api/agent/scans needs the IT PIN for manual scans only", () => {
  const payload = () => payloadFixture("windows-desktop");

  test("manual scan with the current PIN is stored and the attempt recorded", async () => {
    const { token, deviceId } = await registerDevice();
    expect((await postScan(token, scanBody(payload()))).status).toBe(201);
    const rows = await getDb().select().from(settingsUnlockAttempts).where(sql`method = 'manual_scan'`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ deviceId, success: true });
  });

  test("manual scan without a PIN is 403 wrong_pin and not stored", async () => {
    const { token } = await registerDevice();
    const without: Record<string, unknown> = { ...scanBody(payload()) };
    delete without.it_pin;
    const res = await postScan(token, without);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "wrong_pin" });
    expect((await getDb().execute(sql`select count(*)::int as n from scans`))[0]).toMatchObject({ n: 0 });
  });

  test("manual scan with a wrong PIN is 403 and not stored; the sixth try is 429", async () => {
    const { token } = await registerDevice();
    for (let i = 0; i < MAX_WRONG_PER_WINDOW; i++) {
      expect((await postScan(token, scanBody(payload(), { it_pin: wrongPin() }))).status).toBe(403);
    }
    expect((await postScan(token, scanBody(payload()))).status).toBe(429);
    expect((await getDb().execute(sql`select count(*)::int as n from scans`))[0]).toMatchObject({ n: 0 });
  });

  test("on_demand, scheduled and startup scans need no PIN, even after wrong tries", async () => {
    const { token } = await registerDevice();
    for (let i = 0; i < MAX_WRONG_PER_WINDOW; i++) await unlock(token, { pin: wrongPin() });
    for (const scan_type of ["on_demand", "scheduled", "startup"]) {
      expect((await postScan(token, scanBody(payload(), { scan_type }))).status).toBe(201);
    }
  });
});
