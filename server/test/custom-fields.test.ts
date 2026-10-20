import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { RegisterResponse } from "@pcreader/contracts";
import { asc, eq } from "drizzle-orm";
import { closeDb, getDb } from "@/db";
import { deviceFieldHistory, deviceFieldValues, secretAccessLog, settingsUnlockAttempts, staffUser } from "@/db/schema";
import { handleRegister } from "@/lib/agent/register";
import { getDeviceFields, getSecretAccessLog } from "@/lib/custom-fields";
import {
  handleCreateField,
  handleDeviceFields,
  handleListFields,
  handleReorderFields,
  handleRevealSecret,
  handleSetFieldValue,
  handleSetSecret,
  handleUpdateField,
} from "@/lib/dashboard-fields";
import { decryptSecret, encryptSecret, secretsDisabledReason, SecretsDecryptError } from "@/lib/secrets-crypto";
import { getDeviceHistory, listDevices } from "@/lib/queries";
import { jsonRequest, prepareDatabase, registerFixture, resetDatabase, testPin } from "./helpers";

beforeAll(prepareDatabase);
beforeEach(resetDatabase);
afterAll(closeDb);

let STAFF = "";
beforeEach(async () => {
  [{ id: STAFF }] = await getDb().insert(staffUser).values({ id: "staff-1", name: "Ira IT", email: "ira@x.ph", hrisSub: "hris-1" }).returning({ id: staffUser.id });
});

const KEY = Buffer.alloc(32, 1).toString("base64");

describe("secrets-crypto", () => {
  test("round trip, with a fresh nonce each time", () => {
    const a = encryptSecret("hunter2", "ctx", KEY);
    const b = encryptSecret("hunter2", "ctx", KEY);
    expect(a.nonce.equals(b.nonce)).toBe(false);
    expect(a.ciphertext.includes(Buffer.from("hunter2"))).toBe(false);
    expect(decryptSecret(a.ciphertext, a.nonce, "ctx", KEY)).toBe("hunter2");
  });
  test("tampered ciphertext, wrong key and wrong context all fail", () => {
    const { ciphertext, nonce } = encryptSecret("hunter2", "ctx", KEY);
    const flipped = Buffer.from(ciphertext);
    flipped[0] ^= 1;
    expect(() => decryptSecret(flipped, nonce, "ctx", KEY)).toThrow(SecretsDecryptError);
    expect(() => decryptSecret(ciphertext, nonce, "ctx", Buffer.alloc(32, 2).toString("base64"))).toThrow(SecretsDecryptError);
    expect(() => decryptSecret(ciphertext, nonce, "other", KEY)).toThrow(SecretsDecryptError);
  });
  test("a missing or wrong-length key is refused", () => {
    expect(() => encryptSecret("x", "c", "")).toThrow(/not set/);
    expect(() => encryptSecret("x", "c", Buffer.alloc(16).toString("base64"))).toThrow(/32 bytes/);
    expect(secretsDisabledReason("")).toMatch(/not set/);
    expect(secretsDisabledReason(KEY)).toBeNull();
  });
});

async function newDevice(hostname: string): Promise<string> {
  const body = { ...registerFixture("windows-desktop"), device_uuid: crypto.randomUUID(), hostname };
  const res = await handleRegister(jsonRequest("/api/agent/register", { ...body, user: { ...body.user, employee_id: `E-${hostname}` } }), getDb());
  return ((await res.json()) as RegisterResponse).device_id;
}

const send = (method: string, body: unknown) => new Request("http://localhost/x", { method, headers: { "content-type": "application/json", "x-forwarded-for": "10.0.0.9" }, body: JSON.stringify(body) });
type Field = { id: string; name: string; type: string; position: number; archived: boolean };
async function newField(name: string, type: "text" | "date" | "secret"): Promise<Field> {
  const res = await handleCreateField(send("POST", { name, type }), getDb());
  expect(res.status).toBe(201);
  return (await res.json()) as Field;
}
const err = async (res: Response) => ((await res.json()) as { error: string }).error;

describe("field definitions", () => {
  test("create, list in order, rename, reorder, archive and restore", async () => {
    const a = await newField("Registered email", "text");
    const b = await newField("Warranty until", "date");
    const c = await newField("Local admin password", "secret");
    expect([a.position, b.position, c.position]).toEqual([0, 1, 2]);

    const renamed = (await (await handleUpdateField(send("PATCH", { name: "Email" }), getDb(), a.id)).json()) as Field;
    expect(renamed.name).toBe("Email");
    expect(renamed.type).toBe("text");

    expect((await handleReorderFields(send("POST", { ids: [c.id, a.id, b.id] }), getDb())).status).toBe(200);
    const list = (await (await handleListFields(getDb())).json()) as { secrets_enabled: boolean; fields: Field[] };
    expect(list.secrets_enabled).toBe(true);
    expect(list.fields.map((f) => f.id)).toEqual([c.id, a.id, b.id]);

    await handleUpdateField(send("PATCH", { archived: true }), getDb(), b.id);
    const active = (await (await handleListFields(getDb())).json()) as { fields: Field[] };
    expect(active.fields.map((f) => f.id)).toEqual([c.id, a.id]);
    const all = (await (await handleListFields(getDb(), true)).json()) as { fields: Field[] };
    expect(all.fields.find((f) => f.id === b.id)?.archived).toBe(true);
    await handleUpdateField(send("PATCH", { archived: false }), getDb(), b.id);
    expect(((await (await handleListFields(getDb())).json()) as { fields: Field[] }).fields).toHaveLength(3);
  });
  test("validation: names, types, duplicates, order must list every active field", async () => {
    const a = await newField("Asset tag", "text");
    expect((await handleCreateField(send("POST", { name: "  ", type: "text" }), getDb())).status).toBe(400);
    expect((await handleCreateField(send("POST", { name: "x", type: "dropdown" }), getDb())).status).toBe(400);
    const dup = await handleCreateField(send("POST", { name: "ASSET TAG", type: "date" }), getDb());
    expect(dup.status).toBe(409);
    expect((await handleReorderFields(send("POST", { ids: [] }), getDb())).status).toBe(400);
    expect((await handleUpdateField(send("PATCH", {}), getDb(), a.id)).status).toBe(400);
    expect((await handleUpdateField(send("PATCH", { name: "x" }), getDb(), crypto.randomUUID())).status).toBe(404);
  });
});

describe("text and date values", () => {
  test("set, change and clear are recorded with old and new values; no-ops are not", async () => {
    const dev = await newDevice("A");
    const email = await newField("Email", "text");
    const warranty = await newField("Warranty", "date");
    const set = (fieldId: string, value: string | null) => handleSetFieldValue(send("PUT", { value }), getDb(), dev, fieldId, STAFF);

    expect(((await (await set(email.id, "a@x.ph")).json()) as { changed: boolean }).changed).toBe(true);
    expect(((await (await set(email.id, " a@x.ph ")).json()) as { changed: boolean }).changed).toBe(false);
    await set(email.id, "b@x.ph");
    await set(warranty.id, "2027-03-01");
    await set(email.id, null);

    const rows = await getDb().select().from(deviceFieldHistory).where(eq(deviceFieldHistory.deviceId, dev)).orderBy(asc(deviceFieldHistory.changedAt));
    expect(rows.map((r) => [r.field, r.oldValue, r.newValue])).toEqual([
      ["custom_field", null, "a@x.ph"],
      ["custom_field", "a@x.ph", "b@x.ph"],
      ["custom_field", null, "2027-03-01"],
      ["custom_field", "b@x.ph", null],
    ]);
    const timeline = await getDeviceHistory(getDb(), dev);
    expect(timeline.filter((h) => h.kind === "custom_field").map((h) => h.fieldName).sort()).toEqual(["Email", "Email", "Email", "Warranty"]);

    const shown = (await (await handleDeviceFields(getDb(), dev)).json()) as { fields: Array<{ name: string; value: string | null }> };
    expect(shown.fields.map((f) => [f.name, f.value])).toEqual([["Email", null], ["Warranty", "2027-03-01"]]);
  });
  test("bad dates, long text, unknown ids and secret fields are refused", async () => {
    const dev = await newDevice("A");
    const text = await newField("T", "text");
    const date = await newField("D", "date");
    const secret = await newField("S", "secret");
    const put = (fid: string, value: unknown, device = dev) => handleSetFieldValue(send("PUT", { value }), getDb(), device, fid, STAFF);
    expect((await put(date.id, "2027-02-30")).status).toBe(400);
    expect((await put(date.id, "01/03/2027")).status).toBe(400);
    expect((await put(text.id, "x".repeat(501))).status).toBe(400);
    expect((await put(text.id, 5)).status).toBe(400);
    expect((await put(secret.id, "plain")).status).toBe(400);
    expect((await put(text.id, "ok", crypto.randomUUID())).status).toBe(404);
    expect((await put(crypto.randomUUID(), "ok")).status).toBe(404);
    expect((await put("nope", "ok")).status).toBe(404);
  });
  test("archiving hides a field but keeps its values; restoring brings them back", async () => {
    const dev = await newDevice("A");
    const f = await newField("Email", "text");
    await handleSetFieldValue(send("PUT", { value: "keep@x.ph" }), getDb(), dev, f.id, STAFF);
    await handleUpdateField(send("PATCH", { archived: true }), getDb(), f.id);
    expect(await getDeviceFields(getDb(), dev)).toHaveLength(0);
    expect((await handleSetFieldValue(send("PUT", { value: "new" }), getDb(), dev, f.id, STAFF)).status).toBe(409);
    expect((await getDb().select().from(deviceFieldValues))[0].textValue).toBe("keep@x.ph");
    await handleUpdateField(send("PATCH", { archived: false }), getDb(), f.id);
    expect((await getDeviceFields(getDb(), dev))[0].text).toBe("keep@x.ph");
  });
});

describe("secret fields", () => {
  const setSecretReq = (dev: string, fid: string, value: unknown, pin: unknown) => handleSetSecret(send("PUT", { value, pin }), getDb(), dev, fid, STAFF);
  const revealReq = (dev: string, fid: string, pin: unknown) => handleRevealSecret(send("POST", { pin }), getDb(), dev, fid, STAFF);

  test("set with the PIN, reveal with the PIN; stored encrypted; logged without the value", async () => {
    const dev = await newDevice("A");
    const f = await newField("Local admin password", "secret");
    expect((await setSecretReq(dev, f.id, "P@ssw0rd-123", testPin())).status).toBe(200);

    const [stored] = await getDb().select().from(deviceFieldValues);
    expect(stored.secretCiphertext!.includes(Buffer.from("P@ssw0rd-123"))).toBe(false);
    expect(stored.textValue).toBeNull();

    const res = await revealReq(dev, f.id, testPin());
    expect(res.status).toBe(200);
    expect(((await res.json()) as { value: string }).value).toBe("P@ssw0rd-123");

    const log = await getDb().select().from(secretAccessLog).orderBy(asc(secretAccessLog.accessedAt));
    expect(log.map((l) => [l.action, l.success, l.clientIp])).toEqual([["set", true, "10.0.0.9"], ["reveal", true, "10.0.0.9"]]);
    expect(log.every((l) => l.staffUserId === STAFF)).toBe(true);
    expect((await getDb().select().from(deviceFieldHistory)).every((h) => h.changedBy === STAFF)).toBe(true);
    expect((await getSecretAccessLog(getDb(), dev)).every((l) => l.staffName === "Ira IT")).toBe(true);
    expect(JSON.stringify(log)).not.toContain("P@ssw0rd-123");
    const attempts = await getDb().select().from(settingsUnlockAttempts);
    expect(attempts.map((a) => a.method).filter((m) => m !== "register").sort()).toEqual(["reveal_secret", "set_secret"]);
    expect(JSON.stringify(await getDb().select().from(deviceFieldHistory))).not.toContain("P@ssw0rd-123");
  });
  test("a wrong PIN is 403 and logged as a failure; nothing is stored or revealed", async () => {
    const dev = await newDevice("A");
    const f = await newField("Secret", "secret");
    const res = await setSecretReq(dev, f.id, "abc", "000000-not-it");
    expect(res.status).toBe(403);
    expect(await err(res)).toBe("wrong_pin");
    expect(await getDb().select().from(deviceFieldValues)).toHaveLength(0);

    await setSecretReq(dev, f.id, "abc", testPin());
    const bad = await revealReq(dev, f.id, "nope");
    expect(bad.status).toBe(403);
    expect(JSON.stringify(await bad.json())).not.toContain("abc");
    expect((await revealReq(dev, f.id, undefined)).status).toBe(403);
    const log = await getDb().select().from(secretAccessLog).orderBy(asc(secretAccessLog.accessedAt));
    expect(log.map((l) => [l.action, l.success])).toEqual([["set", false], ["set", true], ["reveal", false], ["reveal", false]]);
  });
  test("five wrong PINs a minute lock further tries out with 429, even the right PIN", async () => {
    const dev = await newDevice("A");
    const f = await newField("Secret", "secret");
    await setSecretReq(dev, f.id, "abc", testPin());
    for (let i = 0; i < 5; i++) expect((await revealReq(dev, f.id, "wrong")).status).toBe(403);
    const locked = await revealReq(dev, f.id, testPin());
    expect(locked.status).toBe(429);
    expect(await err(locked)).toBe("too_many_attempts");
  });
  test("changing and clearing a secret show up in the history as 'changed' without values", async () => {
    const dev = await newDevice("A");
    const f = await newField("Secret", "secret");
    await setSecretReq(dev, f.id, "one", testPin());
    await setSecretReq(dev, f.id, "two", testPin());
    expect(((await (await revealReq(dev, f.id, testPin())).json()) as { value: string }).value).toBe("two");
    expect((await setSecretReq(dev, f.id, null, testPin())).status).toBe(200);
    expect((await revealReq(dev, f.id, testPin())).status).toBe(404);

    const events = (await getDeviceHistory(getDb(), dev)).filter((h) => h.kind === "custom_field");
    expect(events).toHaveLength(3);
    for (const e of events) expect([e.secret, e.from, e.to]).toEqual([true, null, null]);
    expect((await getDb().select().from(secretAccessLog)).filter((l) => l.action === "clear")).toHaveLength(1);
  });
  test("a secret never appears in the list, device fields or text-field routes", async () => {
    const dev = await newDevice("A");
    const f = await newField("Secret", "secret");
    await setSecretReq(dev, f.id, "TOPSECRET", testPin());
    const bodies = [await (await handleDeviceFields(getDb(), dev)).text(), await (await handleListFields(getDb(), true)).text()];
    for (const b of bodies) expect(b).not.toContain("TOPSECRET");
    const shown = (await (await handleDeviceFields(getDb(), dev)).json()) as { fields: Array<{ has_value?: boolean; value?: string }> };
    expect(shown.fields[0]).toMatchObject({ has_value: true });
    expect(shown.fields[0].value).toBeUndefined();
    expect(JSON.stringify(await listDevices(getDb(), { q: "TOPSECRET" }))).toBe("[]");
  });
  test("without SECRETS_KEY the routes answer 503 and the list says why", async () => {
    const dev = await newDevice("A");
    const f = await newField("Secret", "secret");
    const key = process.env.SECRETS_KEY;
    delete process.env.SECRETS_KEY;
    try {
      const res = await setSecretReq(dev, f.id, "abc", testPin());
      expect(res.status).toBe(503);
      expect(await err(res)).toBe("secrets_unavailable");
      const list = (await (await handleListFields(getDb())).json()) as { secrets_enabled: boolean; secrets_disabled_reason: string };
      expect(list.secrets_enabled).toBe(false);
      expect(list.secrets_disabled_reason).toMatch(/SECRETS_KEY/);
    } finally {
      process.env.SECRETS_KEY = key;
    }
  });
  test("a text field is not a secret field and vice versa; unknown ids are 404", async () => {
    const dev = await newDevice("A");
    const t = await newField("T", "text");
    expect((await setSecretReq(dev, t.id, "x", testPin())).status).toBe(400);
    expect((await revealReq(dev, t.id, testPin())).status).toBe(400);
    expect((await revealReq(crypto.randomUUID(), t.id, testPin())).status).toBe(404);
    const s = await newField("S", "secret");
    expect((await setSecretReq(dev, s.id, "x".repeat(1001), testPin())).status).toBe(400);
  });
  test("a ciphertext copied to another device does not decrypt there", async () => {
    const a = await newDevice("A");
    const b = await newDevice("B");
    const f = await newField("S", "secret");
    await setSecretReq(a, f.id, "mine", testPin());
    const [row] = await getDb().select().from(deviceFieldValues);
    await getDb().insert(deviceFieldValues).values({ deviceId: b, fieldId: f.id, secretCiphertext: row.secretCiphertext, secretNonce: row.secretNonce });
    expect((await revealReq(b, f.id, testPin())).status).toBe(503);
  });
});

describe("device list search and filters", () => {
  test("q finds text custom field values; date filters bound the range", async () => {
    const a = await newDevice("A");
    const b = await newDevice("B");
    const note = await newField("Registered email", "text");
    const warranty = await newField("Warranty", "date");
    const put = (dev: string, fid: string, value: string) => handleSetFieldValue(send("PUT", { value }), getDb(), dev, fid, STAFF);
    await put(a, note.id, "frontdesk@agency.ph");
    await put(a, warranty.id, "2026-12-31");
    await put(b, warranty.id, "2027-06-30");

    expect((await listDevices(getDb(), { q: "frontdesk" })).map((d) => d.hostname)).toEqual(["A"]);
    expect(await listDevices(getDb(), { q: "nomatch-zzz" })).toHaveLength(0);
    const df = (after?: string, before?: string) => listDevices(getDb(), { dateField: { fieldId: warranty.id, after, before } }).then((r) => r.map((d) => d.hostname));
    expect(await df(undefined, "2026-12-31")).toEqual(["A"]);
    expect(await df("2027-01-01")).toEqual(["B"]);
    expect(await df("2026-01-01", "2027-12-31")).toEqual(["A", "B"]);
    expect(await df("2028-01-01")).toEqual([]);

    await handleUpdateField(send("PATCH", { archived: true }), getDb(), note.id);
    expect(await listDevices(getDb(), { q: "frontdesk" })).toHaveLength(0);
  });
});
