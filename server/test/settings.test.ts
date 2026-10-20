import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { validateBrandingResponse, type RegisterResponse } from "@pcreader/contracts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { closeDb, getDb } from "@/db";
import { migrationsFolder } from "@/db/migrate";
import { handleBranding, handleBrandingLogo } from "@/lib/branding";
import { handleClearLogo, handleGetSettings, handleSetLogo, handleUpdateSettings } from "@/lib/dashboard-settings";
import { handleRegister } from "@/lib/agent/register";
import { assignNextNumber, setInventoryNumber } from "@/lib/inventory";
import { getSettings, MAX_LOGO_BYTES, parseAgencyName, parseInventoryPrefix } from "@/lib/settings";
import { jsonRequest, prepareDatabase, registerFixture, resetDatabase } from "./helpers";

beforeAll(prepareDatabase);
beforeEach(resetDatabase);
afterAll(closeDb);

const png = (extra = 0) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(extra).fill(7)]);
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);

const upload = (bytes: Uint8Array, type: string) => handleSetLogo(new Request("http://localhost/api/dashboard/settings/logo", { method: "POST", headers: { "content-type": type }, body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer }), getDb());
const save = (body: unknown) => handleUpdateSettings(jsonRequest("/api/dashboard/settings", body), getDb());

async function newDevice(hostname: string): Promise<string> {
  const body = { ...registerFixture("windows-desktop"), device_uuid: crypto.randomUUID(), hostname };
  const res = await handleRegister(jsonRequest("/api/agent/register", { ...body, user: { ...body.user, employee_id: `E-${hostname}` } }), getDb());
  return ((await res.json()) as RegisterResponse).device_id;
}

describe("defaults", () => {
  test("name PC_READER, no logo, prefix INV", async () => {
    expect(await (await handleGetSettings(getDb())).json()).toEqual({ agency_name: "PC_READER", inventory_prefix: "INV", logo_url: null });
  });
  test("the first generated number uses INV", async () => {
    const id = await newDevice("A");
    expect((await assignNextNumber(getDb(), id, null, new Date("2026-10-19T04:00:00Z"))).inventoryNumber).toBe("INV-2026-00001");
  });
});

describe("public branding endpoint", () => {
  test("matches the branding.response contract with and without a logo", async () => {
    expect(validateBrandingResponse(await (await handleBranding(getDb())).json())).toBe(true);
    await upload(png(), "image/png");
    const body = await (await handleBranding(getDb())).json();
    expect(validateBrandingResponse(body)).toBe(true);
    expect((body as { logo_url: string | null }).logo_url).not.toBeNull();
  });
});

describe("validation", () => {
  test("agency name is trimmed, collapsed, non-empty, at most 100 characters", () => {
    expect(parseAgencyName("  Dept.   of  Works ")).toBe("Dept. of Works");
    expect(() => parseAgencyName("   ")).toThrow(/empty/);
    expect(() => parseAgencyName("x".repeat(101))).toThrow(/at most 100/);
    expect(() => parseAgencyName("a\u0000b")).toThrow(/control/);
    expect(() => parseAgencyName(5)).toThrow(/string/);
  });
  test("prefix is 2-10 characters, A-Z and 0-9, upper-cased", () => {
    expect(parseInventoryPrefix(" dpw1 ")).toBe("DPW1");
    for (const bad of ["A", "ABCDEFGHIJK", "AB-C", "AB C", "ÄB", "", "A.B"]) expect(() => parseInventoryPrefix(bad)).toThrow();
  });
  test("the API answers 400 with the reason and changes nothing", async () => {
    const res = await save({ agency_name: "Good Name", inventory_prefix: "bad prefix" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toMatch(/prefix/);
    expect((await getSettings(getDb())).agencyName).toBe("PC_READER");
    expect((await save({})).status).toBe(400);
  });
});

describe("saving", () => {
  test("name and prefix show in the settings and the public branding endpoint", async () => {
    const res = await save({ agency_name: "Dept. of Works", inventory_prefix: "dpw" });
    expect(await res.json()).toEqual({ agency_name: "Dept. of Works", inventory_prefix: "DPW", logo_url: null });
    expect(await (await handleBranding(getDb())).json()).toEqual({ name: "Dept. of Works", logo_url: null });
  });
  test("a prefix change affects new numbers only; the counter carries on", async () => {
    const [a, b, c] = await Promise.all([newDevice("A"), newDevice("B"), newDevice("C")]);
    const now = new Date("2026-10-19T04:00:00Z");
    await save({ inventory_prefix: "AAA" });
    expect((await assignNextNumber(getDb(), a, null, now)).inventoryNumber).toBe("AAA-2026-00001");
    await save({ inventory_prefix: "BBB" });
    expect((await assignNextNumber(getDb(), b, null, now)).inventoryNumber).toBe("BBB-2026-00002");
    expect((await getDb().execute(sql`select inventory_number from devices where id = ${a}`))[0].inventory_number).toBe("AAA-2026-00001");
    // A typed number in the current pattern raises the counter; one in the old pattern does not.
    await setInventoryNumber(getDb(), c, "bbb-2026-00050");
    expect((await getDb().execute(sql`select inventory_number from devices where id = ${c}`))[0].inventory_number).toBe("BBB-2026-00050");
    const d = await newDevice("D");
    expect((await assignNextNumber(getDb(), d, null, now)).inventoryNumber).toBe("BBB-2026-00051");
  });
});

describe("logo", () => {
  test("PNG, JPEG and WebP are accepted and served with their content type", async () => {
    for (const [bytes, type] of [[png(), "image/png"], [jpeg, "image/jpeg"], [webp, "image/webp"]] as const) {
      const res = await upload(bytes, type);
      expect(res.status).toBe(200);
      const { logo_url } = (await res.json()) as { logo_url: string };
      expect(logo_url).toMatch(/^\/api\/branding\/logo\?v=\d+$/);
      const served = await handleBrandingLogo(new Request(`http://localhost${logo_url}`), getDb());
      expect(served.status).toBe(200);
      expect(served.headers.get("content-type")).toBe(type);
      expect(served.headers.get("cache-control")).toContain("immutable");
      expect(new Uint8Array(await served.arrayBuffer())).toEqual(bytes);
    }
  });
  test("an unversioned or stale URL must revalidate", async () => {
    await upload(png(), "image/png");
    const res = await handleBrandingLogo(new Request("http://localhost/api/branding/logo?v=1"), getDb());
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });
  test("SVG and other types are refused (415)", async () => {
    expect((await upload(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"), "image/svg+xml")).status).toBe(415);
    expect((await upload(png(), "text/html")).status).toBe(415);
    expect((await upload(png(), "")).status).toBe(415);
  });
  test("the bytes must match the declared type", async () => {
    expect((await upload(jpeg, "image/png")).status).toBe(400);
    expect((await upload(new TextEncoder().encode("<script>alert(1)</script>"), "image/png")).status).toBe(400);
    expect((await upload(new Uint8Array(), "image/png")).status).toBe(400);
  });
  test("at most 512 KB", async () => {
    expect((await upload(png(MAX_LOGO_BYTES - 8), "image/png")).status).toBe(200);
    const big = await upload(png(MAX_LOGO_BYTES - 7), "image/png");
    expect(big.status).toBe(413);
    expect(((await big.json()) as { error: string }).error).toBe("payload_too_large");
  });
  test("a refused upload keeps the current logo; remove clears it", async () => {
    await upload(png(), "image/png");
    await upload(jpeg, "image/png");
    expect((await getSettings(getDb())).logoContentType).toBe("image/png");
    const res = await handleClearLogo(getDb());
    expect(((await res.json()) as { logo_url: null }).logo_url).toBeNull();
    expect((await handleBrandingLogo(new Request("http://localhost/api/branding/logo"), getDb())).status).toBe(404);
  });
  test("replacing the logo changes the version in the public URL", async () => {
    const first = ((await (await upload(png(), "image/png")).json()) as { logo_url: string }).logo_url;
    await Bun.sleep(5);
    const second = ((await (await upload(jpeg, "image/jpeg")).json()) as { logo_url: string }).logo_url;
    expect(second).not.toBe(first);
    expect(((await (await handleBranding(getDb())).json()) as { logo_url: string }).logo_url).toBe(second);
  });
});

describe("upgrade rule (migration 0006)", () => {
  const rerun = async (setup: () => Promise<void>) => {
    await getDb().execute(sql`drop table app_settings`);
    await setup();
    // Replays 0006's own SQL (not the migrator, which would also try to re-run every later migration).
    const file = readFileSync(join(migrationsFolder, "0006_sticky_mercury.sql"), "utf8");
    for (const statement of file.split("--> statement-breakpoint")) await getDb().execute(sql.raw(statement));
    return (await getSettings(getDb())).inventoryPrefix;
  };
  test("existing IA-YYYY-NNNNN numbers keep the IA prefix", async () => {
    const id = await newDevice("A");
    expect(await rerun(async () => void (await getDb().execute(sql`update devices set inventory_number = 'IA-2026-00007' where id = ${id}`)))).toBe("IA");
  });
  test("a server that has issued numbers before (counter row) keeps IA", async () => {
    expect(await rerun(async () => void (await getDb().execute(sql`insert into inventory_counters (year, last_value) values (2026, 3)`)))).toBe("IA");
  });
  test("a fresh server starts with INV", async () => {
    expect(await rerun(async () => {})).toBe("INV");
  });
});
