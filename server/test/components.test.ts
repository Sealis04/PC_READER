import { describe, expect, test } from "bun:test";
import { cleanSerial, deriveComponents } from "@/lib/components";
import { payloadFixture } from "./helpers";

describe("cleanSerial", () => {
  test.each([["To be filled by O.E.M."], ["Default string"], ["0000000"], ["  "], [null]])("treats %p as no serial", (v) => {
    expect(cleanSerial(v)).toBeNull();
  });
  test("trims padding", () => {
    expect(cleanSerial("   SAMPLE-HDD-0001")).toBe("SAMPLE-HDD-0001");
  });
});

describe("deriveComponents", () => {
  test("keys are unique and stable for the same payload", () => {
    const a = deriveComponents(payloadFixture("windows-desktop")).map((c) => c.matchKey);
    const b = deriveComponents(payloadFixture("windows-desktop")).map((c) => c.matchKey);
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(a.length);
  });

  test("identical parts without serials get distinct keys", () => {
    const p = payloadFixture("windows-desktop");
    p.gpus.push({ ...p.gpus[0] });
    const keys = deriveComponents(p).filter((c) => c.category === "gpu").map((c) => c.matchKey);
    expect(keys).toEqual(["gpu:Intel(R) UHD Graphics 770", "gpu:Intel(R) UHD Graphics 770#2"]);
  });

  test("skips external drives and virtual adapters", () => {
    const p = payloadFixture("windows-desktop");
    p.storage.push({ ...p.storage[0], serial_number: "USB1", is_internal: false, bus_type: "USB" });
    p.network.adapters.push({ ...p.network.adapters[0], name: "VPN", is_physical: false, mac_address: "02:00:00:00:00:09" });
    const derived = deriveComponents(p);
    expect(derived.filter((c) => c.category === "storage")).toHaveLength(2);
    expect(derived.filter((c) => c.category === "nic")).toHaveLength(2);
  });
});
