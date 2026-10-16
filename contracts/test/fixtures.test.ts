import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { formatErrors, validateRegisterRequest, validateScanPayload, validateScansRequest } from "../index";

const fixtures = join(import.meta.dir, "..", "fixtures");
const load = (rel: string) => JSON.parse(readFileSync(join(fixtures, rel), "utf8"));
const files = (dir: string) => readdirSync(join(fixtures, dir)).filter((f) => f.endsWith(".json"));

describe("payload fixtures", () => {
  const names = files("payload");
  test("there is one per supported platform", () => {
    expect(names).toEqual(expect.arrayContaining(["windows-desktop.json", "macos-apple-silicon.json", "macos-intel.json"]));
  });
  for (const name of names) {
    test(`${name} matches scan-payload.v1`, () => {
      const ok = validateScanPayload(load(`payload/${name}`));
      expect(formatErrors(validateScanPayload.errors)).toEqual([]);
      expect(ok).toBe(true);
    });
    test(`${name} is accepted inside a scans request`, () => {
      const body = { scan_uuid: crypto.randomUUID(), scan_type: "manual", collected_at: new Date().toISOString(), payload: load(`payload/${name}`) };
      expect(validateScansRequest(body)).toBe(true);
    });
  }
});

describe("register fixtures", () => {
  for (const name of files("register")) {
    test(`${name} matches register.request`, () => {
      const ok = validateRegisterRequest(load(`register/${name}`));
      expect(formatErrors(validateRegisterRequest.errors)).toEqual([]);
      expect(ok).toBe(true);
    });
  }
});

describe("schema rules", () => {
  const base = () => load("payload/windows-desktop.json");

  test("omitted fields are rejected (null is required instead)", () => {
    const p = base();
    delete p.system.chip_name;
    expect(validateScanPayload(p)).toBe(false);
  });

  test("unknown fields are rejected", () => {
    const p = base();
    p.system.extra = "x";
    expect(validateScanPayload(p)).toBe(false);
  });

  test("schema_version must be 1", () => {
    const p = base();
    p.schema_version = 2;
    expect(validateScanPayload(p)).toBe(false);
  });

  test("MAC addresses must be upper-case and colon-separated", () => {
    const p = base();
    p.network.adapters[0].mac_address = "d0-8e-79-00-00-01";
    expect(validateScanPayload(p)).toBe(false);
  });

  test("policy must be acknowledged to register", () => {
    const r = load("register/windows-desktop.json");
    r.user.policy_acknowledged = false;
    expect(validateRegisterRequest(r)).toBe(false);
  });
});
