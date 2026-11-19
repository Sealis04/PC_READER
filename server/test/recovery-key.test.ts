import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { pbkdf2Sync } from "node:crypto";
import { validateEventsMessage, validateOkResponse, type RegisterResponse, type SecretHash } from "@pcreader/contracts";
import { eq } from "drizzle-orm";
import { closeDb, getDb } from "@/db";
import { devices, recoveryKeyAccessLog, recoveryKeys, settingsUnlockAttempts } from "@/db/schema";
import { handleRecoveryKeyAck } from "@/lib/agent/recovery-key-ack";
import { handleRegister } from "@/lib/agent/register";
import { handleRevealDeviceRecoveryKey, handleRecoveryStatus, handleRevealRecoveryKey, handleRotateRecoveryKey } from "@/lib/dashboard-recovery-key";
import { listDevices } from "@/lib/queries";
import {
  currentKey,
  formatKey,
  generateKey,
  KEY_ALPHABET,
  normalizeKey,
  recoveryStatus,
  ROTATE_AFTER_MS,
  rotateIfDue,
  versionLabel,
} from "@/lib/recovery-key";
import { auth, ENROLLMENT_KEY, jsonRequest, loadFixture, prepareDatabase, registerFixture, resetDatabase, Stream, testPin } from "./helpers";

beforeAll(prepareDatabase);
beforeEach(resetDatabase);
afterAll(closeDb);

const db = () => getDb();

async function register(key = ENROLLMENT_KEY): Promise<Response> {
  return handleRegister(jsonRequest("/api/agent/register", { ...registerFixture("windows-desktop"), enrollment_key: key }), db());
}

async function registerDevice(): Promise<{ token: string; deviceId: string }> {
  const res = await register();
  expect(res.status).toBe(201);
  const b = (await res.json()) as RegisterResponse;
  return { token: b.device_token, deviceId: b.device_id };
}

const reveal = (body: unknown, ip = "10.0.0.9") => handleRevealRecoveryKey(jsonRequest("/api/dashboard/recovery-key/reveal", body, { "x-forwarded-for": ip }), db());
const rotate = (body: unknown, ip = "10.0.0.9") => handleRotateRecoveryKey(jsonRequest("/api/dashboard/recovery-key/rotate", body, { "x-forwarded-for": ip }), db());

function pcHashMatches(h: SecretHash, key: string): boolean {
  return pbkdf2Sync(normalizeKey(key), Buffer.from(h.salt, "base64"), h.iterations, 32, "sha256").toString("base64") === h.hash;
}

describe("key format", () => {
  test("new keys are 16 characters from the unambiguous alphabet, shown in 4 groups", () => {
    expect(KEY_ALPHABET).not.toMatch(/[01OIL]/);
    for (let i = 0; i < 50; i++) {
      const k = generateKey();
      expect(k).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{16}$/);
      expect(formatKey(k)).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    }
  });
  test("typing is case-insensitive, dashes and spaces optional", () => {
    expect(normalizeKey("  k7qm-2xrp 9wdf-h4tn ")).toBe("K7QM2XRP9WDFH4TN");
    expect(formatKey("k7qm2xrp9wdfh4tn")).toBe("K7QM-2XRP-9WDF-H4TN");
    // A legacy (seeded) key that is not in the new format is shown as it is.
    expect(formatKey(ENROLLMENT_KEY)).toBe(ENROLLMENT_KEY);
  });
  test("the contract fixture's hash is this server's PBKDF2 of the sample key (the agent checks the same)", () => {
    const m = loadFixture<{ data: { hash: SecretHash } }>("events/recovery-key.json");
    expect(pcHashMatches(m.data.hash, "k7qm-2xrp 9wdf-h4tn")).toBe(true);
  });
});

describe("seeding", () => {
  test("an empty table takes ENROLLMENT_KEY as version 1, so existing PCs and setups keep working", async () => {
    const row = await currentKey(db());
    expect(row!.version).toBe(1);
    expect(row!.source).toBe("seed");
    expect(pcHashMatches(row!.pcHash as SecretHash, ENROLLMENT_KEY)).toBe(true);
    expect(row!.ciphertext.toString("utf8")).not.toContain(ENROLLMENT_KEY);
    expect((await register()).status).toBe(201);
    // The seeded key is compared normalized as well.
    expect((await register(ENROLLMENT_KEY.toUpperCase())).status).toBe(201);
  });

  test("once keys exist the env value is ignored; the status says it differs", async () => {
    await currentKey(db());
    const saved = process.env.ENROLLMENT_KEY;
    process.env.ENROLLMENT_KEY = "a-different-env-key";
    try {
      expect((await register("a-different-env-key")).status).toBe(403);
      expect((await register(saved)).status).toBe(201);
      expect((await recoveryStatus(db())).envDiffers).toBe(true);
    } finally {
      process.env.ENROLLMENT_KEY = saved;
    }
    expect((await recoveryStatus(db())).envDiffers).toBe(false);
  });

  test("without ENROLLMENT_KEY a new database gets a generated key", async () => {
    const saved = process.env.ENROLLMENT_KEY;
    delete process.env.ENROLLMENT_KEY;
    try {
      expect((await register(saved)).status).toBe(403);
      const res = await reveal({ pin: testPin() });
      const { key } = (await res.json()) as { key: string };
      expect(key).toMatch(/^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/);
      expect((await register(key.toLowerCase().replaceAll("-", " "))).status).toBe(201);
    } finally {
      process.env.ENROLLMENT_KEY = saved;
    }
  });

  test("without SECRETS_KEY nothing is stored and ENROLLMENT_KEY works as before", async () => {
    const secrets = process.env.SECRETS_KEY;
    delete process.env.SECRETS_KEY;
    try {
      expect((await register()).status).toBe(201);
      expect(await db().select().from(recoveryKeys)).toHaveLength(0);
      const status = await (await handleRecoveryStatus(db())).json();
      expect(status.enabled).toBe(false);
      expect(status.disabled_reason).toMatch(/SECRETS_KEY/);
      expect(await rotateIfDue(db(), new Date(Date.now() + 2 * ROTATE_AFTER_MS))).toBeNull();
      expect((await rotate({ pin: testPin() })).status).toBe(503);
      expect((await reveal({ pin: testPin() })).status).toBe(503);
    } finally {
      process.env.SECRETS_KEY = secrets;
    }
  });
});

describe("rotation", () => {
  test("rotates only when the current key is 30 days old; only the current version registers", async () => {
    const first = (await currentKey(db()))!;
    expect(await rotateIfDue(db(), new Date(first.createdAt.getTime() + ROTATE_AFTER_MS - 60_000))).toBeNull();
    const second = await rotateIfDue(db(), new Date(first.createdAt.getTime() + ROTATE_AFTER_MS + 1));
    expect(second!.version).toBe(2);
    expect(second!.source).toBe("auto");
    const rows = await db().select().from(recoveryKeys);
    expect(rows.find((r) => r.version === 1)!.retiredAt).not.toBeNull();
    expect((await register()).status).toBe(403);
    const { key } = (await (await reveal({ pin: testPin() })).json()) as { key: string };
    expect((await register(key)).status).toBe(201);
    const log = await db().select().from(recoveryKeyAccessLog).where(eq(recoveryKeyAccessLog.action, "rotate"));
    expect(log).toHaveLength(1);
    expect(log[0].success).toBe(true);
  });

  test("New key now needs the current IT PIN; wrong PINs are 403 then 429, all logged", async () => {
    await currentKey(db());
    const ok = await rotate({ pin: testPin() });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ version: 2 });
    expect((await currentKey(db()))!.source).toBe("manual");
    for (let i = 0; i < 5; i++) expect((await rotate({ pin: "000000" }, "10.0.0.7")).status).toBe(403);
    expect((await rotate({ pin: testPin() }, "10.0.0.7")).status).toBe(429);
    expect((await currentKey(db()))!.version).toBe(2);
    const log = await db().select().from(recoveryKeyAccessLog).where(eq(recoveryKeyAccessLog.action, "rotate"));
    expect(log.filter((l) => l.success)).toHaveLength(1);
    // The refused (429) try is logged too.
    expect(log.filter((l) => !l.success)).toHaveLength(6);
    const attempts = await db().select().from(settingsUnlockAttempts).where(eq(settingsUnlockAttempts.method, "rotate_recovery_key"));
    expect(attempts.length).toBe(6);
  });
});

describe("reveal", () => {
  test("shows the current key with the PIN, an older version on request, logged without the value", async () => {
    await currentKey(db());
    await rotate({ pin: testPin() });
    const cur = await (await reveal({ pin: testPin() })).json();
    expect(cur.version).toBe(2);
    expect(cur.key).toMatch(/^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/);
    const old = await (await reveal({ pin: testPin(), version: 1 })).json();
    expect(old).toEqual({ version: 1, key: ENROLLMENT_KEY });
    expect((await reveal({ pin: "000000" })).status).toBe(403);
    expect((await reveal({ pin: testPin(), version: 9 })).status).toBe(404);
    expect((await reveal({ pin: testPin(), version: "x" })).status).toBe(400);
    const log = await db().select().from(recoveryKeyAccessLog).where(eq(recoveryKeyAccessLog.action, "reveal"));
    expect(log.map((l) => l.success).sort()).toEqual([false, false, true, true]);
    expect(JSON.stringify(log)).not.toContain(cur.key);
  });

  test("the key is in no other response", async () => {
    await currentKey(db());
    const { key } = await (await reveal({ pin: testPin() })).json();
    const status = JSON.stringify(await (await handleRecoveryStatus(db())).json());
    expect(status).not.toContain(key);
    const { token } = await registerDevice();
    const s = await Stream.open(token);
    try {
      expect((await s.next()).event).toBe("hello");
      const m = await s.next();
      expect(JSON.stringify(m)).not.toContain(key);
      expect(JSON.stringify(m)).not.toContain(normalizeKey(key));
    } finally {
      await s.close();
    }
  });

  test("a device page reveals the version that PC holds; unknown is 404", async () => {
    await currentKey(db());
    const { token, deviceId } = await registerDevice();
    const url = `/api/dashboard/devices/${deviceId}/recovery-key/reveal`;
    expect((await handleRevealDeviceRecoveryKey(jsonRequest(url, { pin: testPin() }), db(), deviceId)).status).toBe(404);
    await handleRecoveryKeyAck(jsonRequest("/api/agent/recovery-key/ack", { version: 1 }, auth(token)), db());
    await rotate({ pin: testPin() });
    const res = await handleRevealDeviceRecoveryKey(jsonRequest(url, { pin: testPin() }), db(), deviceId);
    expect(await res.json()).toEqual({ version: 1, key: ENROLLMENT_KEY });
    const [log] = await db().select().from(recoveryKeyAccessLog).where(eq(recoveryKeyAccessLog.deviceId, deviceId));
    expect(log.version).toBe(1);
    expect((await handleRevealDeviceRecoveryKey(jsonRequest(url, { pin: testPin() }), db(), "nope")).status).toBe(404);
  });
});

describe("keeping PCs in step", () => {
  test("on connect a PC without the current version gets its hash; after the ack it does not", async () => {
    const { token, deviceId } = await registerDevice();
    let s = await Stream.open(token);
    try {
      expect((await s.next()).event).toBe("hello");
      const m = await s.next();
      expect(validateEventsMessage(m)).toBe(true);
      expect(m.event).toBe("recovery_key");
      const data = m.data as { version: number; hash: SecretHash };
      expect(data.version).toBe(1);
      expect(pcHashMatches(data.hash, ENROLLMENT_KEY)).toBe(true);
    } finally {
      await s.close();
    }
    const ack = await handleRecoveryKeyAck(jsonRequest("/api/agent/recovery-key/ack", { version: 1 }, auth(token)), db());
    expect(ack.status).toBe(200);
    expect(validateOkResponse(await ack.json())).toBe(true);
    const [d] = await db().select().from(devices).where(eq(devices.id, deviceId));
    expect(d.recoveryKeyVersion).toBe(1);
    expect(d.recoveryKeyAckedAt).not.toBeNull();

    s = await Stream.open(token);
    try {
      expect((await s.next()).event).toBe("hello");
      await expect(s.next(300)).rejects.toThrow(/timed out/);
    } finally {
      await s.close();
    }
  });

  test("a rotation is pushed to every open stream", async () => {
    const a = await registerDevice();
    const s = await Stream.open(a.token);
    try {
      await s.next(); // hello
      await s.next(); // recovery_key v1 (not acknowledged yet)
      await rotate({ pin: testPin() });
      const m = await s.next();
      expect(m.event).toBe("recovery_key");
      expect((m.data as { version: number }).version).toBe(2);
    } finally {
      await s.close();
    }
  });

  test("ack rejects an unknown version (409), a bad body (400) and a bad token (401)", async () => {
    const { token } = await registerDevice();
    expect((await handleRecoveryKeyAck(jsonRequest("/x", { version: 7 }, auth(token)), db())).status).toBe(409);
    expect((await handleRecoveryKeyAck(jsonRequest("/x", { version: "1" }, auth(token)), db())).status).toBe(400);
    expect((await handleRecoveryKeyAck(jsonRequest("/x", { version: 1 }, auth("nope")), db())).status).toBe(401);
  });

  test("behind count, list filter and labels", async () => {
    const a = await registerDevice();
    const other = registerFixture("macos-apple-silicon");
    const res = await handleRegister(jsonRequest("/api/agent/register", other), db());
    const b = (await res.json()) as RegisterResponse;
    await handleRecoveryKeyAck(jsonRequest("/x", { version: 1 }, auth(a.token)), db());
    expect((await recoveryStatus(db())).behind).toBe(1);
    await rotate({ pin: testPin() });
    expect((await recoveryStatus(db())).behind).toBe(2);
    const behind = await listDevices(db(), { recoveryBehind: 2 });
    expect(behind.map((d) => d.id).sort()).toEqual([a.deviceId, b.device_id].sort());
    await handleRecoveryKeyAck(jsonRequest("/x", { version: 2 }, auth(a.token)), db());
    expect((await listDevices(db(), { recoveryBehind: 2 })).map((d) => d.id)).toEqual([b.device_id]);
    expect(versionLabel(2, 2)).toBe("v2 (current)");
    expect(versionLabel(5, 7)).toBe("v5 (2 behind)");
    expect(versionLabel(null, 7)).toBe("unknown");
  });
});
