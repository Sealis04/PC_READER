import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { and, count, desc, eq, gte, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { itPinState, settingsUnlockAttempts, type SettingsUnlockAttempt } from "@/db/schema";
import { TIME_ZONE } from "@/lib/format";

// The IT PIN: 6 digits from HMAC(secret, local hour + generation), like TOTP with a 1-hour step.
// The hour is read in DISPLAY_TIMEZONE, so the PIN changes at the top of the hour there. "Change
// now" bumps the generation, which changes the PIN until the next hour boundary and beyond.
// Only the current PIN is valid; PC clocks play no part because the server does the check.

export const PIN_DIGITS = 6;
export const MAX_WRONG_PER_WINDOW = 5;
export const RATE_WINDOW_MS = 60_000;

const hourParts = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIME_ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

function localParts(now: Date): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of hourParts.formatToParts(now)) if (p.type !== "literal") out[p.type] = Number(p.value);
  return out;
}

// "2026-10-20T15" — the wall-clock hour in the display time zone.
function hourKey(now: Date): string {
  const p = localParts(now);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}`;
}

// The next top of the hour in the display time zone (whole-hour zones and the :30/:45 ones alike,
// since it counts the minutes left in the local hour).
export function expiresAt(now: Date): Date {
  const p = localParts(now);
  const ms = ((59 - p.minute) * 60 + (60 - p.second)) * 1000 - now.getMilliseconds();
  return new Date(now.getTime() + ms);
}

function derive(secret: string, generation: number, now: Date): string {
  const mac = createHmac("sha256", secret).update(`${hourKey(now)}:${generation}`).digest();
  // RFC 4226 dynamic truncation.
  const offset = mac[mac.length - 1] & 0x0f;
  const code = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(code % 10 ** PIN_DIGITS).padStart(PIN_DIGITS, "0");
}

// The one state row; created with a random secret on first use. IT_PIN_SECRET, when set, replaces
// the stored secret (the stored one is then simply not used).
async function loadState(db: Db): Promise<{ secret: string; generation: number; rotatedAt: Date }> {
  await db.insert(itPinState).values({ id: 1, secret: randomBytes(32).toString("hex") }).onConflictDoNothing();
  const [row] = await db.select().from(itPinState).where(eq(itPinState.id, 1));
  return { secret: process.env.IT_PIN_SECRET || row.secret, generation: row.generation, rotatedAt: row.rotatedAt };
}

export interface CurrentPin {
  pin: string;
  expiresAt: Date;
}

export async function currentPin(db: Db, now = new Date()): Promise<CurrentPin> {
  const s = await loadState(db);
  return { pin: derive(s.secret, s.generation, now), expiresAt: expiresAt(now) };
}

// Dashboard "Change now": the PIN changes immediately; the next hour still rotates as usual.
export async function rotateNow(db: Db, now = new Date()): Promise<CurrentPin> {
  await loadState(db);
  await db
    .update(itPinState)
    .set({ generation: sql`${itPinState.generation} + 1`, rotatedAt: now })
    .where(eq(itPinState.id, 1));
  return currentPin(db, now);
}

export type VerifyResult = "ok" | "wrong_pin" | "too_many_attempts";

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// Checks a PC's typed PIN and records the attempt. A device with MAX_WRONG_PER_WINDOW wrong tries in
// the last minute is refused (and not recorded again) until the oldest of them ages out.
export async function verifyPin(db: Db, deviceId: string, pin: string, now = new Date()): Promise<VerifyResult> {
  const since = new Date(now.getTime() - RATE_WINDOW_MS);
  const [{ wrong }] = await db
    .select({ wrong: count() })
    .from(settingsUnlockAttempts)
    .where(
      and(
        eq(settingsUnlockAttempts.deviceId, deviceId),
        eq(settingsUnlockAttempts.success, false),
        gte(settingsUnlockAttempts.attemptedAt, since),
      ),
    );
  if (wrong >= MAX_WRONG_PER_WINDOW) return "too_many_attempts";

  const s = await loadState(db);
  const success = safeEqual(derive(s.secret, s.generation, now), pin);
  await db.insert(settingsUnlockAttempts).values({ deviceId, attemptedAt: now, success, method: "hourly_pin" });
  return success ? "ok" : "wrong_pin";
}

export const UNLOCK_ATTEMPT_LIMIT = 20;

export async function getUnlockAttempts(db: Db, deviceId: string): Promise<SettingsUnlockAttempt[]> {
  return db
    .select()
    .from(settingsUnlockAttempts)
    .where(eq(settingsUnlockAttempts.deviceId, deviceId))
    .orderBy(desc(settingsUnlockAttempts.attemptedAt))
    .limit(UNLOCK_ATTEMPT_LIMIT);
}
