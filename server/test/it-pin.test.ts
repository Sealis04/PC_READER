import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { validateSettingsUnlockResponse, type RegisterResponse } from "@pcreader/contracts";
import { asc } from "drizzle-orm";
import { closeDb, getDb } from "@/db";
import { settingsUnlockAttempts } from "@/db/schema";
import { handleRegister } from "@/lib/agent/register";
import { handleSettingsUnlock } from "@/lib/agent/settings-unlock";
import { currentPin, expiresAt, MAX_WRONG_PER_WINDOW, rotateNow, verifyPin } from "@/lib/it-pin";
import { jsonRequest, prepareDatabase, registerFixture, resetDatabase } from "./helpers";

beforeAll(prepareDatabase);
beforeEach(resetDatabase);
afterAll(closeDb);

// Asia/Manila is UTC+8 with no DST: 15:00 PHT is 07:00Z.
const at = (iso: string) => new Date(iso);
const notPin = (pin: string) => (pin === "000000" ? "000001" : "000000");

async function registerDevice(): Promise<{ token: string; deviceId: string }> {
  const res = await handleRegister(jsonRequest("/api/agent/register", registerFixture("windows-desktop")), getDb());
  const body = (await res.json()) as RegisterResponse;
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
    const stored = await currentPin(db, now);
    process.env.IT_PIN_SECRET = "fixed-secret-for-tests";
    try {
      const a = await currentPin(db, now);
      expect(a.pin).not.toBe(stored.pin);
      expect((await currentPin(db, now)).pin).toBe(a.pin);
    } finally {
      delete process.env.IT_PIN_SECRET;
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

    expect(await verifyPin(db, deviceId, notPin(pin), now)).toBe("wrong_pin");
    expect(await verifyPin(db, deviceId, old, now)).toBe("wrong_pin");
    expect(await verifyPin(db, deviceId, pin, now)).toBe("ok");

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
    expect(await verifyPin(db, deviceId, pin, now)).toBe("wrong_pin");
  });

  test("refuses a device after too many wrong tries in a minute, until they age out", async () => {
    const db = getDb();
    const { deviceId } = await registerDevice();
    const now = at("2026-10-20T07:30:00.000Z");
    const { pin } = await currentPin(db, now);
    for (let i = 0; i < MAX_WRONG_PER_WINDOW; i++) expect(await verifyPin(db, deviceId, notPin(pin), now)).toBe("wrong_pin");
    // Even the right PIN is refused while rate limited, and refusals are not recorded.
    expect(await verifyPin(db, deviceId, pin, now)).toBe("too_many_attempts");
    expect(await db.select().from(settingsUnlockAttempts)).toHaveLength(MAX_WRONG_PER_WINDOW);
    expect(await verifyPin(db, deviceId, pin, at("2026-10-20T07:30:30.000Z"))).toBe("too_many_attempts");
    expect(await verifyPin(db, deviceId, pin, at("2026-10-20T07:31:01.000Z"))).toBe("ok");
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
