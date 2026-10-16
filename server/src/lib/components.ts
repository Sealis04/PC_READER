import type { ScanPayload } from "@pcreader/contracts";
import { and, eq, isNull, notInArray } from "drizzle-orm";
import type { Db } from "@/db";
import { components, type NewComponent } from "@/db/schema";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export type DerivedComponent = Pick<
  NewComponent,
  "category" | "matchKey" | "manufacturer" | "model" | "serialNumber" | "capacityBytes" | "details" | "isIntegrated"
>;

// Values firmware writes when the real serial is unknown; treated as no serial.
const PLACEHOLDER_SERIALS = new Set([
  "",
  "0",
  "none",
  "n/a",
  "na",
  "default string",
  "to be filled by o.e.m.",
  "system serial number",
  "not specified",
  "not available",
  "unknown",
]);

export function cleanSerial(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  if (PLACEHOLDER_SERIALS.has(trimmed.toLowerCase()) || /^0+$/.test(trimmed)) return null;
  return trimmed;
}

const clean = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

// Turns a scan payload into component rows, each with a key that stays stable across scans:
// serial number or MAC when available, otherwise descriptive fields plus an occurrence counter.
export function deriveComponents(payload: ScanPayload): DerivedComponent[] {
  const out: DerivedComponent[] = [];
  const seen = new Map<string, number>();
  const key = (base: string) => {
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}#${n}`;
  };

  for (const cpu of payload.cpus) {
    out.push({
      category: "cpu",
      matchKey: key(`cpu:${clean(cpu.model) ?? "unknown"}`),
      manufacturer: clean(cpu.manufacturer),
      model: clean(cpu.model),
      serialNumber: null,
      capacityBytes: null,
      details: { cores: cpu.cores, threads: cpu.threads, base_speed_mhz: cpu.base_speed_mhz },
      isIntegrated: cpu.is_integrated,
    });
  }

  const mem = payload.memory;
  if (mem.modules === null) {
    out.push({
      category: "ram",
      matchKey: key("ram:total"),
      manufacturer: null,
      model: null,
      serialNumber: null,
      capacityBytes: mem.total_bytes,
      details: {},
      isIntegrated: mem.is_integrated,
    });
  } else {
    for (const m of mem.modules) {
      const serial = cleanSerial(m.serial_number);
      out.push({
        category: "ram",
        matchKey: key(serial ? `ram:sn:${serial}` : `ram:slot:${clean(m.slot) ?? "?"}:${clean(m.part_number) ?? "?"}`),
        manufacturer: clean(m.manufacturer),
        model: clean(m.part_number),
        serialNumber: serial,
        capacityBytes: m.size_bytes,
        details: { slot: clean(m.slot), speed_mhz: m.speed_mhz },
        isIntegrated: mem.is_integrated,
      });
    }
  }

  // External drives (USB sticks, backup disks) are not parts of the device.
  for (const d of payload.storage.filter((s) => s.is_internal !== false)) {
    const serial = cleanSerial(d.serial_number);
    out.push({
      category: "storage",
      matchKey: key(serial ? `storage:sn:${serial}` : `storage:${clean(d.model) ?? "?"}:${d.size_bytes ?? "?"}`),
      manufacturer: null,
      model: clean(d.model),
      serialNumber: serial,
      capacityBytes: d.size_bytes,
      details: { media_type: d.media_type, bus_type: clean(d.bus_type) },
      isIntegrated: d.is_integrated,
    });
  }

  const mb = payload.motherboard;
  if (mb) {
    const serial = cleanSerial(mb.serial_number);
    out.push({
      category: "motherboard",
      matchKey: key(serial ? `motherboard:sn:${serial}` : `motherboard:${clean(mb.manufacturer) ?? "?"}:${clean(mb.product) ?? "?"}`),
      manufacturer: clean(mb.manufacturer),
      model: clean(mb.product),
      serialNumber: serial,
      capacityBytes: null,
      details: {},
      isIntegrated: false,
    });
  }

  for (const g of payload.gpus) {
    out.push({
      category: "gpu",
      matchKey: key(`gpu:${clean(g.name) ?? "unknown"}`),
      manufacturer: null,
      model: clean(g.name),
      serialNumber: null,
      capacityBytes: g.memory_bytes,
      details: { driver_version: clean(g.driver_version) },
      isIntegrated: g.is_integrated,
    });
  }

  for (const a of payload.network.adapters.filter((n) => n.is_physical && n.mac_address)) {
    out.push({
      category: "nic",
      matchKey: key(`nic:mac:${a.mac_address}`),
      manufacturer: null,
      model: a.name,
      serialNumber: a.mac_address,
      capacityBytes: null,
      details: { type: a.type },
      isIntegrated: false,
    });
  }

  return out;
}

export type SyncResult = { added: number; updated: number; removed: number };

// Applies a scan's components: new keys are inserted, known keys updated, and active
// components missing from the scan get removed_at set (kept for history, never deleted).
export async function syncComponents(tx: Tx, deviceId: string, derived: DerivedComponent[], now: Date): Promise<SyncResult> {
  const active = await tx
    .select({ id: components.id, matchKey: components.matchKey })
    .from(components)
    .where(and(eq(components.deviceId, deviceId), isNull(components.removedAt)));
  const byKey = new Map(active.map((c) => [c.matchKey, c.id]));

  let added = 0;
  let updated = 0;
  for (const c of derived) {
    const id = byKey.get(c.matchKey);
    if (id) {
      await tx.update(components).set({ ...c, updatedAt: now }).where(eq(components.id, id));
      updated++;
    } else {
      await tx.insert(components).values({ ...c, deviceId, firstSeenAt: now });
      added++;
    }
  }

  const keep = derived.map((c) => c.matchKey);
  const removedRows = await tx
    .update(components)
    .set({ removedAt: now, updatedAt: now })
    .where(
      and(
        eq(components.deviceId, deviceId),
        isNull(components.removedAt),
        keep.length ? notInArray(components.matchKey, keep) : undefined,
      ),
    )
    .returning({ id: components.id });

  return { added, updated, removed: removedRows.length };
}
