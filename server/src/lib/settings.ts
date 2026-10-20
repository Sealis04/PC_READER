import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { appSettings } from "@/db/schema";

// This server's agency branding and inventory number prefix (single row, id = 1).
export const DEFAULT_AGENCY_NAME = "PC_READER";
export const DEFAULT_INVENTORY_PREFIX = "INV";
export const MAX_AGENCY_NAME_LENGTH = 100;
export const MIN_PREFIX_LENGTH = 2;
export const MAX_PREFIX_LENGTH = 10;
export const MAX_LOGO_BYTES = 512 * 1024;
// No SVG: it can carry scripts.
export const LOGO_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export type LogoType = (typeof LOGO_TYPES)[number];

export class SettingsError extends Error {
  constructor(
    public readonly status: 400 | 413 | 415,
    public readonly code: "invalid_payload" | "payload_too_large" | "unsupported_media_type",
    message: string,
  ) {
    super(message);
  }
}

// Works inside a transaction as well as on the pool.
type Executor = Pick<Db, "select" | "insert" | "update">;

export interface Settings {
  agencyName: string;
  inventoryPrefix: string;
  logoContentType: LogoType | null;
  logoUpdatedAt: Date | null;
}

const columns = {
  agencyName: appSettings.agencyName,
  inventoryPrefix: appSettings.inventoryPrefix,
  logoContentType: appSettings.logoContentType,
  logoUpdatedAt: appSettings.logoUpdatedAt,
};

// The settings row is created on first read with the defaults (the migration seeds it on upgrades).
export async function getSettings(db: Executor): Promise<Settings> {
  const read = () => db.select(columns).from(appSettings).where(eq(appSettings.id, 1)).limit(1);
  let [row] = await read();
  if (!row) {
    await db.insert(appSettings).values({ id: 1 }).onConflictDoNothing();
    [row] = await read();
  }
  return row as Settings;
}

export function parseAgencyName(value: unknown): string {
  if (typeof value !== "string") throw new SettingsError(400, "invalid_payload", "agency_name must be a string");
  const name = value.trim().replace(/\s+/g, " ");
  if (!name) throw new SettingsError(400, "invalid_payload", "The agency name cannot be empty");
  if (name.length > MAX_AGENCY_NAME_LENGTH) throw new SettingsError(400, "invalid_payload", `The agency name must be at most ${MAX_AGENCY_NAME_LENGTH} characters`);
  if (/[\u0000-\u001f\u007f]/.test(name)) throw new SettingsError(400, "invalid_payload", "The agency name cannot contain control characters");
  return name;
}

export function parseInventoryPrefix(value: unknown): string {
  if (typeof value !== "string") throw new SettingsError(400, "invalid_payload", "inventory_prefix must be a string");
  const prefix = value.trim().toUpperCase();
  if (!new RegExp(`^[A-Z0-9]{${MIN_PREFIX_LENGTH},${MAX_PREFIX_LENGTH}}$`).test(prefix)) {
    throw new SettingsError(400, "invalid_payload", `The inventory prefix must be ${MIN_PREFIX_LENGTH}-${MAX_PREFIX_LENGTH} characters, letters A-Z and digits 0-9 only`);
  }
  return prefix;
}

// Changing the prefix affects new numbers only; existing numbers and the per-year counters stay.
export async function updateSettings(db: Db, patch: { agencyName?: unknown; inventoryPrefix?: unknown }): Promise<Settings> {
  const set: Partial<typeof appSettings.$inferInsert> = {};
  if (patch.agencyName !== undefined) set.agencyName = parseAgencyName(patch.agencyName);
  if (patch.inventoryPrefix !== undefined) set.inventoryPrefix = parseInventoryPrefix(patch.inventoryPrefix);
  await getSettings(db);
  if (Object.keys(set).length > 0) await db.update(appSettings).set({ ...set, updatedAt: new Date() }).where(eq(appSettings.id, 1));
  return getSettings(db);
}

const startsWith = (b: Uint8Array, bytes: number[], at = 0) => bytes.every((v, i) => b[at + i] === v);

// The bytes must really be the image type that was declared.
function sniffLogoType(b: Uint8Array): LogoType | null {
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(b, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(b, [0x52, 0x49, 0x46, 0x46]) && startsWith(b, [0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  return null;
}

export async function setLogo(db: Db, bytes: Uint8Array, contentType: string): Promise<Settings> {
  const type = contentType.split(";")[0].trim().toLowerCase();
  if (!(LOGO_TYPES as readonly string[]).includes(type)) throw new SettingsError(415, "unsupported_media_type", "The logo must be a PNG, JPEG or WebP image");
  if (bytes.length === 0) throw new SettingsError(400, "invalid_payload", "The logo file is empty");
  if (bytes.length > MAX_LOGO_BYTES) throw new SettingsError(413, "payload_too_large", `The logo must be at most ${MAX_LOGO_BYTES / 1024} KB`);
  if (sniffLogoType(bytes) !== type) throw new SettingsError(400, "invalid_payload", `The file is not a valid ${type.slice(6).toUpperCase()} image`);
  await getSettings(db);
  const now = new Date();
  await db.update(appSettings).set({ logo: Buffer.from(bytes), logoContentType: type, logoUpdatedAt: now, updatedAt: now }).where(eq(appSettings.id, 1));
  return getSettings(db);
}

export async function clearLogo(db: Db): Promise<Settings> {
  await getSettings(db);
  const now = new Date();
  await db.update(appSettings).set({ logo: null, logoContentType: null, logoUpdatedAt: null, updatedAt: now }).where(eq(appSettings.id, 1));
  return getSettings(db);
}

export async function getLogo(db: Db): Promise<{ bytes: Buffer; contentType: string; updatedAt: Date } | null> {
  const [row] = await db.select({ logo: appSettings.logo, type: appSettings.logoContentType, at: appSettings.logoUpdatedAt }).from(appSettings).where(eq(appSettings.id, 1)).limit(1);
  return row?.logo && row.type && row.at ? { bytes: row.logo, contentType: row.type, updatedAt: row.at } : null;
}

// Relative URL with a version, so a replaced logo is never served from a stale cache.
export function logoUrl(s: Pick<Settings, "logoContentType" | "logoUpdatedAt">): string | null {
  return s.logoContentType && s.logoUpdatedAt ? `/api/branding/logo?v=${s.logoUpdatedAt.getTime()}` : null;
}

export interface Branding {
  name: string;
  logo_url: string | null;
}

export const brandingOf = (s: Settings): Branding => ({ name: s.agencyName, logo_url: logoUrl(s) });

// For the dashboard layout: falls back to the defaults when the database cannot be read (e.g. at build).
export async function safeBranding(db: () => Db): Promise<Branding> {
  try {
    return brandingOf(await getSettings(db()));
  } catch {
    return { name: DEFAULT_AGENCY_NAME, logo_url: null };
  }
}
