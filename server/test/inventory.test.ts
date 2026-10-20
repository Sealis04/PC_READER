import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { RegisterResponse } from "@pcreader/contracts";
import { asc, eq } from "drizzle-orm";
import { closeDb, getDb } from "@/db";
import { deviceFieldHistory, devices, inventoryCounters, statusHistory } from "@/db/schema";
import { handleRegister } from "@/lib/agent/register";
import { getDeviceHistory, listDepartments, listDevices } from "@/lib/queries";
import { handleInventoryAction } from "@/lib/dashboard-inventory";
import { updateSettings } from "@/lib/settings";
import { assignNextNumber, changeStatus, clearInventoryNumber, inventoryYear, InventoryError, parseGeneratedNumber, setInventoryNumber, setLocation } from "@/lib/inventory";
import { jsonRequest, prepareDatabase, registerFixture, resetDatabase } from "./helpers";

beforeAll(prepareDatabase);
// These tests use the IA prefix that upgraded servers keep (the default for new servers is INV).
beforeEach(async () => {
  await resetDatabase();
  await updateSettings(getDb(), { inventoryPrefix: "IA" });
});
afterAll(closeDb);

async function newDevice(hostname: string): Promise<string> {
  const body = { ...registerFixture("windows-desktop"), device_uuid: crypto.randomUUID(), hostname };
  const res = await handleRegister(jsonRequest("/api/agent/register", { ...body, user: { ...body.user, employee_id: `E-${hostname}` } }), getDb());
  return ((await res.json()) as RegisterResponse).device_id;
}

const numberOf = async (id: string) => (await getDb().select().from(devices).where(eq(devices.id, id)))[0].inventoryNumber;
const fieldHistory = (id: string) => getDb().select().from(deviceFieldHistory).where(eq(deviceFieldHistory.deviceId, id)).orderBy(asc(deviceFieldHistory.changedAt));
const rejects = async (p: Promise<unknown>, status: 400 | 404 | 409, message: RegExp) => {
  const e = await p.then(() => null, (err: unknown) => err);
  expect(e).toBeInstanceOf(InventoryError);
  expect((e as InventoryError).status).toBe(status);
  expect((e as InventoryError).message).toMatch(message);
};

describe("inventoryYear / parseGeneratedNumber", () => {
  test("the year follows DISPLAY_TIMEZONE (Asia/Manila), not UTC", () => {
    expect(inventoryYear(new Date("2026-12-31T16:30:00Z"))).toBe(2027);
    expect(inventoryYear(new Date("2026-12-31T15:30:00Z"))).toBe(2026);
  });
  test("only IA-YYYY-NNNNN counts as a generated number", () => {
    expect(parseGeneratedNumber("IA-2026-00123", "IA")).toEqual({ year: 2026, counter: 123 });
    expect(parseGeneratedNumber("ia-2026-00123", "IA")).toEqual({ year: 2026, counter: 123 });
    expect(parseGeneratedNumber("IA-2026-123", "IA")).toBeNull();
    expect(parseGeneratedNumber("OLD-0001", "IA")).toBeNull();
  });
});

describe("assignNextNumber", () => {
  const now = new Date("2026-10-19T04:00:00Z");

  test("counts up within a year and restarts in the next", async () => {
    const [a, b, c] = await Promise.all([newDevice("A"), newDevice("B"), newDevice("C")]);
    expect((await assignNextNumber(getDb(), a, null, now)).inventoryNumber).toBe("IA-2026-00001");
    expect((await assignNextNumber(getDb(), b, null, now)).inventoryNumber).toBe("IA-2026-00002");
    expect((await assignNextNumber(getDb(), c, null, new Date("2027-01-01T00:00:00Z"))).inventoryNumber).toBe("IA-2027-00001");
  });

  test("two concurrent calls get different numbers", async () => {
    const ids = await Promise.all(["A", "B", "C", "D", "E"].map(newDevice));
    const results = await Promise.all(ids.map((id) => assignNextNumber(getDb(), id, null, now)));
    expect(new Set(results.map((r) => r.inventoryNumber)).size).toBe(5);
    expect(results.map((r) => r.inventoryNumber).sort()).toEqual(["IA-2026-00001", "IA-2026-00002", "IA-2026-00003", "IA-2026-00004", "IA-2026-00005"]);
  });

  test("refuses a device that already has a number", async () => {
    const id = await newDevice("A");
    await assignNextNumber(getDb(), id, null, now);
    await rejects(assignNextNumber(getDb(), id, null, now), 409, /already has the number IA-2026-00001/);
  });

  test("a typed number that looks generated pushes the counter; others do not", async () => {
    const [a, b, c] = await Promise.all([newDevice("A"), newDevice("B"), newDevice("C")]);
    await setInventoryNumber(getDb(), a, "ia-2026-00040");
    expect(await numberOf(a)).toBe("IA-2026-00040");
    await setInventoryNumber(getDb(), b, "OLD-STICKER-7");
    expect((await assignNextNumber(getDb(), c, null, now)).inventoryNumber).toBe("IA-2026-00041");
    expect(await getDb().select().from(inventoryCounters)).toEqual([{ year: 2026, lastValue: 41 }]);
  });

  test("a number is not reused after it was cleared or changed", async () => {
    const [a, b] = await Promise.all([newDevice("A"), newDevice("B")]);
    await assignNextNumber(getDb(), a, null, now);
    await clearInventoryNumber(getDb(), a);
    expect((await assignNextNumber(getDb(), b, null, now)).inventoryNumber).toBe("IA-2026-00002");
  });

  test("stops at 99999", async () => {
    const [a, b] = await Promise.all([newDevice("A"), newDevice("B")]);
    await setInventoryNumber(getDb(), a, "IA-2026-99999");
    await rejects(assignNextNumber(getDb(), b, null, now), 409, /used/);
    expect(await numberOf(b)).toBeNull();
  });
});

describe("setInventoryNumber", () => {
  test("is unique regardless of case and names the holder", async () => {
    const [a, b] = await Promise.all([newDevice("PC-A"), newDevice("PC-B")]);
    await setInventoryNumber(getDb(), a, "Sticker-1");
    await rejects(setInventoryNumber(getDb(), b, "sticker-1"), 409, /already assigned to PC-A/);
    expect(await numberOf(b)).toBeNull();
    expect(await fieldHistory(b)).toHaveLength(0);
  });

  test("the database also enforces it", async () => {
    const [a, b] = await Promise.all([newDevice("A"), newDevice("B")]);
    await getDb().update(devices).set({ inventoryNumber: "X-1" }).where(eq(devices.id, a));
    await expect((async () => getDb().update(devices).set({ inventoryNumber: "x-1" }).where(eq(devices.id, b)))()).rejects.toThrow();
  });

  test("trims, validates and records history with the reason", async () => {
    const id = await newDevice("A");
    await rejects(setInventoryNumber(getDb(), id, "   "), 400, /empty/);
    await rejects(setInventoryNumber(getDb(), id, "x".repeat(51)), 400, /50/);
    expect(await setInventoryNumber(getDb(), id, "  S-1  ", "found sticker")).toEqual({ changed: true, inventoryNumber: "S-1" });
    expect(await setInventoryNumber(getDb(), id, "S-1")).toEqual({ changed: false, inventoryNumber: "S-1" });
    await setInventoryNumber(getDb(), id, "S-2");
    await clearInventoryNumber(getDb(), id, "typo");
    expect(await clearInventoryNumber(getDb(), id)).toEqual({ changed: false });
    const rows = await fieldHistory(id);
    expect(rows.map((r) => [r.field, r.oldValue, r.newValue, r.reason, r.changedBy])).toEqual([
      ["inventory_number", null, "S-1", "found sticker", null],
      ["inventory_number", "S-1", "S-2", null, null],
      ["inventory_number", "S-2", null, "typo", null],
    ]);
  });
});

describe("changeStatus / setLocation", () => {
  test("status change writes a history row; a no-op writes none", async () => {
    const id = await newDevice("A");
    expect(await changeStatus(getDb(), id, "in_use")).toEqual({ changed: false });
    expect(await changeStatus(getDb(), id, "under_repair", "  broken screen ")).toEqual({ changed: true });
    expect(await changeStatus(getDb(), id, "under_repair")).toEqual({ changed: false });
    const rows = await getDb().select().from(statusHistory).where(eq(statusHistory.deviceId, id));
    expect(rows.map((r) => [r.oldStatus, r.newStatus, r.reason, r.changedBy])).toEqual([["in_use", "under_repair", "broken screen", null]]);
    expect((await getDb().select().from(devices).where(eq(devices.id, id)))[0].status).toBe("under_repair");
    await rejects(changeStatus(getDb(), id, "nope" as never), 400, /status must be one of/);
  });

  test("location is trimmed, cleared with an empty value, and recorded", async () => {
    const id = await newDevice("A");
    await setLocation(getDb(), id, "  Room 2  ", "moved");
    expect(await setLocation(getDb(), id, "Room 2")).toEqual({ changed: false });
    await setLocation(getDb(), id, "");
    expect(await setLocation(getDb(), id, null)).toEqual({ changed: false });
    const rows = await fieldHistory(id);
    expect(rows.map((r) => [r.field, r.oldValue, r.newValue, r.reason])).toEqual([
      ["location", null, "Room 2", "moved"],
      ["location", "Room 2", null, null],
    ]);
  });

  test("unknown device is a 404", async () => {
    await rejects(changeStatus(getDb(), crypto.randomUUID(), "spare"), 404, /No such device/);
    await rejects(setLocation(getDb(), crypto.randomUUID(), "x"), 404, /No such device/);
  });

  test("history rows go when the device is deleted", async () => {
    const id = await newDevice("A");
    await changeStatus(getDb(), id, "spare");
    await setLocation(getDb(), id, "x");
    await getDb().delete(devices).where(eq(devices.id, id));
    expect(await getDb().select().from(statusHistory)).toHaveLength(0);
  });
});

describe("POST /api/dashboard/devices/{id}/inventory", () => {
  const post = async (id: string, body: unknown) => {
    const res = await handleInventoryAction(jsonRequest("/x", body), getDb(), id);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  test("assign, set, status, location, clear", async () => {
    const id = await newDevice("A");
    expect((await post(id, { action: "assign_next" })).body.inventoryNumber).toMatch(/^IA-\d{4}-00001$/);
    expect(await post(id, { action: "set_status", status: "spare", reason: "returned" })).toEqual({ status: 200, body: { changed: true } });
    expect(await post(id, { action: "set_location", value: "Store room" })).toEqual({ status: 200, body: { changed: true } });
    expect(await post(id, { action: "clear_number" })).toEqual({ status: 200, body: { changed: true } });
    expect(await post(id, { action: "set_number", value: "S-9" })).toEqual({ status: 200, body: { changed: true, inventoryNumber: "S-9" } });
  });

  test("errors: 400 bad input, 404 unknown device, 409 duplicate", async () => {
    const [a, b] = await Promise.all([newDevice("A"), newDevice("B")]);
    await post(a, { action: "set_number", value: "S-1" });
    const dup = await post(b, { action: "set_number", value: "s-1" });
    expect(dup.status).toBe(409);
    expect(dup.body).toMatchObject({ error: "conflict", message: "s-1 is already assigned to A" });
    expect((await post(a, { action: "assign_next" })).status).toBe(409);
    expect((await post(a, { action: "bogus" })).status).toBe(400);
    expect((await post(a, { action: "set_status", status: "nope" })).status).toBe(400);
    expect((await post(a, { action: "set_number", value: 5 })).status).toBe(400);
    expect((await post(a, { action: "set_status", status: "spare", reason: 5 })).status).toBe(400);
    expect((await post(crypto.randomUUID(), { action: "assign_next" })).status).toBe(404);
    expect((await post("not-a-uuid", { action: "assign_next" })).status).toBe(404);
  });
});

describe("getDeviceHistory", () => {
  test("merges status, number, location and assignment changes, newest first", async () => {
    const id = await newDevice("A");
    await changeStatus(getDb(), id, "spare", "returned");
    await setInventoryNumber(getDb(), id, "S-1");
    await setLocation(getDb(), id, "Room 2");
    const events = await getDeviceHistory(getDb(), id);
    expect(events.map((e) => e.kind)).toEqual(["location", "inventory_number", "status", "assigned"]);
    expect(events[2]).toMatchObject({ from: "in_use", to: "spare", reason: "returned", by: null });
    expect(events[3].to).toMatch(/\(E-A\)$/);
    for (let i = 1; i < events.length; i++) expect(events[i - 1].at.getTime()).toBeGreaterThanOrEqual(events[i].at.getTime());
  });
});

describe("listDevices filters and search", () => {
  async function seed() {
    const db = getDb();
    const [a, b, c] = await Promise.all([newDevice("ALPHA"), newDevice("BRAVO"), newDevice("CHARLIE")]);
    await setInventoryNumber(db, a, "IA-2026-00007");
    await setInventoryNumber(db, b, "OLD-100%");
    await db.update(devices).set({ serialNumber: "SN-XYZ-1", location: "Room 1" }).where(eq(devices.id, a));
    await db.update(devices).set({ osType: "macos", online: true }).where(eq(devices.id, b));
    await changeStatus(db, c, "spare");
    return { a, b, c };
  }
  const hosts = async (f: Parameters<typeof listDevices>[1]) => (await listDevices(getDb(), f)).map((d) => d.hostname);

  test("filters by status, OS and online state, combined", async () => {
    await seed();
    expect(await hosts({ status: "spare" })).toEqual(["CHARLIE"]);
    expect(await hosts({ os: "macos" })).toEqual(["BRAVO"]);
    expect(await hosts({ connection: "online" })).toEqual(["BRAVO"]);
    expect(await hosts({ status: "in_use", os: "windows" })).toEqual(["ALPHA"]);
    expect(await hosts({ status: "lost" })).toEqual([]);
  });

  test("filters by the assigned user's department", async () => {
    const { a } = await seed();
    const [row] = (await listDevices(getDb())).filter((d) => d.id === a);
    expect(row.department).toBeTruthy();
    expect(await listDepartments(getDb())).toContain(row.department!);
    expect(await hosts({ department: row.department! })).toHaveLength(3);
    expect(await hosts({ department: "No such dept" })).toEqual([]);
  });

  test("searches number, hostname, serial, user name and employee ID, case-insensitively", async () => {
    await seed();
    const [row] = await listDevices(getDb(), { q: "alpha" });
    expect(await hosts({ q: "ia-2026-00007" })).toEqual(["ALPHA"]);
    expect(await hosts({ q: "00007" })).toEqual(["ALPHA"]);
    expect(await hosts({ q: "bravo" })).toEqual(["BRAVO"]);
    expect(await hosts({ q: "sn-xyz" })).toEqual(["ALPHA"]);
    expect(await hosts({ q: "E-CHARLIE" })).toEqual(["CHARLIE"]);
    expect(await hosts({ q: row.userName!.slice(1, 5).toUpperCase() })).toHaveLength(3);
    expect(await hosts({ q: "  nothing-matches " })).toEqual([]);
  });

  test("% and _ in the search are literal", async () => {
    await seed();
    expect(await hosts({ q: "100%" })).toEqual(["BRAVO"]);
    expect(await hosts({ q: "%" })).toEqual(["BRAVO"]);
    expect(await hosts({ q: "_" })).toEqual([]);
  });

  test("rows carry number, status and location", async () => {
    await seed();
    const [row] = await listDevices(getDb(), { q: "alpha" });
    expect(row).toMatchObject({ inventoryNumber: "IA-2026-00007", status: "in_use", location: "Room 1" });
  });
});
