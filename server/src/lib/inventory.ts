import { and, eq, ne, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { deviceFieldHistory, devices, deviceStatus, inventoryCounters, statusHistory, type Device } from "@/db/schema";
import { TIME_ZONE } from "@/lib/format";

// Inventory numbers are generated as IA-YYYY-NNNNN: the year in DISPLAY_TIMEZONE and a 5-digit counter
// that restarts every year. Staff may instead type the number already on a sticker (free text).
export const NUMBER_PREFIX = "IA";
export const MAX_COUNTER = 99999;
export const MAX_NUMBER_LENGTH = 50;
export const MAX_LOCATION_LENGTH = 200;
export const MAX_REASON_LENGTH = 500;

const GENERATED_RE = /^IA-(\d{4})-(\d{5})$/i;

export type DeviceStatus = Device["status"];
export const DEVICE_STATUSES: readonly DeviceStatus[] = deviceStatus.enumValues;
export const isDeviceStatus = (v: unknown): v is DeviceStatus => typeof v === "string" && (DEVICE_STATUSES as readonly string[]).includes(v);

export class InventoryError extends Error {
  constructor(
    public readonly status: 400 | 404 | 409,
    public readonly code: "invalid_payload" | "not_found" | "conflict",
    message: string,
  ) {
    super(message);
  }
}

const yearFormat = new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric" });

export function inventoryYear(now = new Date()): number {
  return Number(yearFormat.format(now));
}

export function formatInventoryNumber(year: number, counter: number): string {
  return `${NUMBER_PREFIX}-${year}-${String(counter).padStart(5, "0")}`;
}

// Year and counter when the value looks like a generated number, else null.
export function parseGeneratedNumber(value: string): { year: number; counter: number } | null {
  const m = GENERATED_RE.exec(value);
  return m ? { year: Number(m[1]), counter: Number(m[2]) } : null;
}

function cleanReason(reason: string | null | undefined): string | null {
  const r = reason?.trim() ?? "";
  if (r.length > MAX_REASON_LENGTH) throw new InventoryError(400, "invalid_payload", `The reason must be at most ${MAX_REASON_LENGTH} characters`);
  return r || null;
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

// Locks the device row for the rest of the transaction so concurrent edits of one device queue up.
async function lockDevice(tx: Tx, id: string): Promise<Device> {
  const [device] = await tx.select().from(devices).where(eq(devices.id, id)).for("update");
  if (!device) throw new InventoryError(404, "not_found", "No such device");
  return device;
}

// Writes the new number and its history row. Typed numbers that look generated raise that year's
// counter so a later "assign next" can never produce the same number.
async function writeNumber(tx: Tx, device: Device, value: string | null, reason: string | null): Promise<void> {
  if (value !== null) {
    const [holder] = await tx
      .select({ id: devices.id, hostname: devices.hostname })
      .from(devices)
      .where(and(sql`lower(${devices.inventoryNumber}) = lower(${value})`, ne(devices.id, device.id)))
      .limit(1);
    if (holder) throw new InventoryError(409, "conflict", `${value} is already assigned to ${holder.hostname}`);
    const generated = parseGeneratedNumber(value);
    if (generated) {
      await tx
        .insert(inventoryCounters)
        .values({ year: generated.year, lastValue: generated.counter })
        .onConflictDoUpdate({ target: inventoryCounters.year, set: { lastValue: sql`greatest(${inventoryCounters.lastValue}, excluded.last_value)` } });
    }
  }
  await tx.update(devices).set({ inventoryNumber: value }).where(eq(devices.id, device.id));
  await tx.insert(deviceFieldHistory).values({ deviceId: device.id, field: "inventory_number", oldValue: device.inventoryNumber, newValue: value, reason });
}

// Issues the next IA-YYYY-NNNNN to a device that has no number yet.
export async function assignNextNumber(db: Db, deviceId: string, reason?: string | null, now = new Date()): Promise<{ inventoryNumber: string }> {
  const why = cleanReason(reason);
  return db.transaction(async (tx) => {
    const device = await lockDevice(tx, deviceId);
    if (device.inventoryNumber) {
      throw new InventoryError(409, "conflict", `This device already has the number ${device.inventoryNumber}; change it explicitly instead`);
    }
    const year = inventoryYear(now);
    // The upsert row-locks the year's counter, so concurrent callers get consecutive values.
    const [row] = await tx
      .insert(inventoryCounters)
      .values({ year, lastValue: 1 })
      .onConflictDoUpdate({ target: inventoryCounters.year, set: { lastValue: sql`${inventoryCounters.lastValue} + 1` } })
      .returning({ lastValue: inventoryCounters.lastValue });
    if (row.lastValue > MAX_COUNTER) {
      throw new InventoryError(409, "conflict", `All ${MAX_COUNTER} inventory numbers for ${year} are used`);
    }
    const inventoryNumber = formatInventoryNumber(year, row.lastValue);
    await writeNumber(tx, device, inventoryNumber, why);
    return { inventoryNumber };
  });
}

// Sets an existing sticker number. Returns changed=false when the device already has exactly that number.
export async function setInventoryNumber(db: Db, deviceId: string, value: string, reason?: string | null): Promise<{ changed: boolean; inventoryNumber: string }> {
  let number = value.trim();
  if (!number) throw new InventoryError(400, "invalid_payload", "The inventory number cannot be empty");
  if (number.length > MAX_NUMBER_LENGTH) throw new InventoryError(400, "invalid_payload", `The inventory number must be at most ${MAX_NUMBER_LENGTH} characters`);
  if (parseGeneratedNumber(number)) number = number.toUpperCase();
  const why = cleanReason(reason);
  return db.transaction(async (tx) => {
    const device = await lockDevice(tx, deviceId);
    if (device.inventoryNumber === number) return { changed: false, inventoryNumber: number };
    await writeNumber(tx, device, number, why);
    return { changed: true, inventoryNumber: number };
  });
}

// Removes a number entered by mistake. The counter is not lowered, so the number is not reissued.
export async function clearInventoryNumber(db: Db, deviceId: string, reason?: string | null): Promise<{ changed: boolean }> {
  const why = cleanReason(reason);
  return db.transaction(async (tx) => {
    const device = await lockDevice(tx, deviceId);
    if (!device.inventoryNumber) return { changed: false };
    await writeNumber(tx, device, null, why);
    return { changed: true };
  });
}

export async function changeStatus(db: Db, deviceId: string, newStatus: DeviceStatus, reason?: string | null): Promise<{ changed: boolean }> {
  if (!isDeviceStatus(newStatus)) throw new InventoryError(400, "invalid_payload", `status must be one of ${DEVICE_STATUSES.join(", ")}`);
  const why = cleanReason(reason);
  return db.transaction(async (tx) => {
    const device = await lockDevice(tx, deviceId);
    if (device.status === newStatus) return { changed: false };
    await tx.update(devices).set({ status: newStatus }).where(eq(devices.id, deviceId));
    await tx.insert(statusHistory).values({ deviceId, oldStatus: device.status, newStatus, reason: why });
    return { changed: true };
  });
}

// An empty value clears the location.
export async function setLocation(db: Db, deviceId: string, value: string | null, reason?: string | null): Promise<{ changed: boolean }> {
  const location = value?.trim() || null;
  if (location && location.length > MAX_LOCATION_LENGTH) throw new InventoryError(400, "invalid_payload", `The location must be at most ${MAX_LOCATION_LENGTH} characters`);
  const why = cleanReason(reason);
  return db.transaction(async (tx) => {
    const device = await lockDevice(tx, deviceId);
    if (device.location === location) return { changed: false };
    await tx.update(devices).set({ location }).where(eq(devices.id, deviceId));
    await tx.insert(deviceFieldHistory).values({ deviceId, field: "location", oldValue: device.location, newValue: location, reason: why });
    return { changed: true };
  });
}
