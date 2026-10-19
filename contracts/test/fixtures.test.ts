import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  formatErrors,
  validateEventsMessage,
  validateEventsRequest,
  validateLogsRequest,
  validateLogsResponse,
  validateNetworkRequest,
  validateNetworkSnapshot,
  validateRegisterRequest,
  validateRequestComplete,
  validateRequestCompleteResponse,
  validateScanPayload,
  validateScansRequest,
  validateSettingsUnlockRequest,
  validateSettingsUnlockResponse,
  validateUserRequest,
} from "../index";

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

describe("user fixtures", () => {
  for (const name of files("user")) {
    test(`${name} matches user.request`, () => {
      const ok = validateUserRequest(load(`user/${name}`));
      expect(formatErrors(validateUserRequest.errors)).toEqual([]);
      expect(ok).toBe(true);
    });
  }

  test("user.request needs the six detail fields and no policy flag", () => {
    const u = load("user/windows-desktop.json");
    expect(validateUserRequest({ ...u, policy_acknowledged: true })).toBe(false);
    delete u.department;
    expect(validateUserRequest(u)).toBe(false);
  });
});

describe("settings-unlock fixtures", () => {
  test("request.json matches settings-unlock.request", () => {
    expect(validateSettingsUnlockRequest(load("settings-unlock/request.json"))).toBe(true);
  });
  test("response.json matches settings-unlock.response", () => {
    expect(validateSettingsUnlockResponse(load("settings-unlock/response.json"))).toBe(true);
  });
  test("the PIN must be exactly six digits", () => {
    for (const pin of ["12345", "1234567", "12345a", "", " 123456"]) {
      expect(validateSettingsUnlockRequest({ pin })).toBe(false);
    }
    expect(validateSettingsUnlockRequest({ pin: "000000" })).toBe(true);
    expect(validateSettingsUnlockRequest({ pin: "123456", extra: 1 })).toBe(false);
  });
  test("the response is only ever ok: true", () => {
    expect(validateSettingsUnlockResponse({ ok: false })).toBe(false);
  });
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

describe("network fixtures", () => {
  for (const name of files("network")) {
    test(`${name} matches network-snapshot and network.request`, () => {
      const body = load(`network/${name}`);
      expect(validateNetworkSnapshot(body)).toBe(true);
      expect(validateNetworkRequest(body)).toBe(true);
    });
  }

  test("needs every field; ssid and gateway may be null, connection_type is an enum", () => {
    const n = load("network/wifi.json");
    expect(validateNetworkSnapshot({ ...n, ssid: null, gateway: null })).toBe(true);
    expect(validateNetworkSnapshot({ ...n, connection_type: "cellular" })).toBe(false);
    expect(validateNetworkSnapshot({ ...n, mac_addresses: ["d0:8e:79:00:00:02"] })).toBe(false);
    const missing = { ...n };
    delete missing.ssid;
    expect(validateNetworkSnapshot(missing)).toBe(false);
    expect(validateNetworkSnapshot({ ...n, extra: 1 })).toBe(false);
  });
});

describe("events fixtures", () => {
  test("query carries agent_version", () => {
    expect(validateEventsRequest(load("events/query.json"))).toBe(true);
    expect(validateEventsRequest({})).toBe(false);
  });
  for (const name of files("events").filter((f) => f !== "query.json")) {
    test(`${name} matches events.message`, () => {
      const ok = validateEventsMessage(load(`events/${name}`));
      expect(formatErrors(validateEventsMessage.errors)).toEqual([]);
      expect(ok).toBe(true);
    });
  }
  test("a request event needs a known type", () => {
    const m = load("events/request-scan-now.json");
    m.data.type = "reboot";
    expect(validateEventsMessage(m)).toBe(false);
  });
});

describe("logs fixtures", () => {
  test("request.json matches logs.request and response.json matches logs.response", () => {
    expect(validateLogsRequest(load("logs/request.json"))).toBe(true);
    expect(validateLogsResponse(load("logs/response.json"))).toBe(true);
  });

  test("batches are 1 to 500 entries with known levels and categories", () => {
    const r = load("logs/request.json");
    const entry = r.entries[0];
    expect(validateLogsRequest({ entries: [] })).toBe(false);
    expect(validateLogsRequest({ entries: Array.from({ length: 500 }, (_, i) => ({ ...entry, local_entry_id: i + 1 })) })).toBe(true);
    expect(validateLogsRequest({ entries: Array.from({ length: 501 }, (_, i) => ({ ...entry, local_entry_id: i + 1 })) })).toBe(false);
    expect(validateLogsRequest({ entries: [{ ...entry, level: "debug" }] })).toBe(false);
    expect(validateLogsRequest({ entries: [{ ...entry, category: "other" }] })).toBe(false);
    expect(validateLogsRequest({ entries: [{ ...entry, local_entry_id: 0 }] })).toBe(false);
  });
});

describe("request-complete fixtures", () => {
  for (const name of files("request-complete")) {
    test(`${name} matches request-complete.request`, () => {
      const ok = validateRequestComplete(load(`request-complete/${name}`));
      expect(formatErrors(validateRequestComplete.errors)).toEqual([]);
      expect(ok).toBe(true);
    });
  }
  test("response is the request id and its final status", () => {
    expect(validateRequestCompleteResponse({ id: crypto.randomUUID(), status: "done" })).toBe(true);
    expect(validateRequestCompleteResponse({ id: crypto.randomUUID(), status: "pending" })).toBe(false);
  });
  test("result must be done or failed; scan_id must be a uuid", () => {
    expect(validateRequestComplete({ result: "pending" })).toBe(false);
    expect(validateRequestComplete({ result: "done", scan_id: "nope" })).toBe(false);
    expect(validateRequestComplete({})).toBe(false);
  });
});
