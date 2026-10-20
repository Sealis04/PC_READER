import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { and, count, desc, eq, gte, isNull, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { itPinState, settingsUnlockAttempts, type SettingsUnlockAttempt } from "@/db/schema";
import { TIME_ZONE } from "@/lib/format";
import { errorResponse } from "@/lib/http";

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

export function derivePin(secret: string, generation: number, now: Date): string {
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
  return { pin: derivePin(s.secret, s.generation, now), expiresAt: expiresAt(now) };
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

export type PinMethod = "hourly_pin" | "register" | "update_details" | "manual_scan" | "confirm_details" | "reveal_secret" | "set_secret";

export const PIN_METHOD_LABEL: Record<PinMethod, string> = {
  hourly_pin: "Settings",
  register: "Signup",
  update_details: "Update my details",
  manual_scan: "Report now",
  confirm_details: "Confirm details (IT request)",
  reveal_secret: "Reveal secret field",
  set_secret: "Change secret field",
};

// Who is trying: a registered device (all its methods share one limit), or, at signup when there is
// no device yet, a client IP.
export type PinSubject = { deviceId: string } | { deviceId: null; clientIp: string };

// Whether the subject has MAX_WRONG_PER_WINDOW wrong tries in the last minute.
export async function tooManyWrong(db: Db, subject: PinSubject, now = new Date()): Promise<boolean> {
  const since = new Date(now.getTime() - RATE_WINDOW_MS);
  const scope =
    subject.deviceId !== null
      ? eq(settingsUnlockAttempts.deviceId, subject.deviceId)
      : and(isNull(settingsUnlockAttempts.deviceId), eq(settingsUnlockAttempts.clientIp, subject.clientIp));
  const [{ wrong }] = await db
    .select({ wrong: count() })
    .from(settingsUnlockAttempts)
    .where(and(scope, eq(settingsUnlockAttempts.success, false), gte(settingsUnlockAttempts.attemptedAt, since)));
  return wrong >= MAX_WRONG_PER_WINDOW;
}

export async function recordAttempt(db: Db, subject: PinSubject, success: boolean, method: PinMethod, now = new Date()): Promise<void> {
  await db.insert(settingsUnlockAttempts).values({
    deviceId: subject.deviceId,
    clientIp: subject.deviceId === null ? subject.clientIp : null,
    attemptedAt: now,
    success,
    method,
  });
}

// Checks a typed PIN and records the attempt. A subject with MAX_WRONG_PER_WINDOW wrong tries in the
// last minute is refused (and not recorded again) until the oldest of them ages out.
export async function verifyPin(db: Db, subject: PinSubject | string, pin: string, method: PinMethod = "hourly_pin", now = new Date()): Promise<VerifyResult> {
  const who: PinSubject = typeof subject === "string" ? { deviceId: subject } : subject;
  if (await tooManyWrong(db, who, now)) return "too_many_attempts";

  const s = await loadState(db);
  const success = safeEqual(derivePin(s.secret, s.generation, now), pin);
  await recordAttempt(db, who, success, method, now);
  return success ? "ok" : "wrong_pin";
}

// IT's approval for one "Ask user to confirm details" request: HMAC(secret, request id), sent to that
// PC with the request over the events stream. With it the user saves their details once without the
// PIN (see lib/agent/user.ts). Nothing is stored; the request's own state makes it single-use.
export const CONFIRM_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

export function deriveApproval(secret: string, requestId: string): string {
  return createHmac("sha256", secret).update(`confirm-details:${requestId}`).digest("base64url");
}

export async function approvalFor(db: Db, requestId: string): Promise<string> {
  return deriveApproval((await loadState(db)).secret, requestId);
}

export async function approvalMatches(db: Db, requestId: string, approval: string): Promise<boolean> {
  return safeEqual(await approvalFor(db, requestId), approval);
}

// The first address in X-Forwarded-For (the reverse proxy's view of the caller); "unknown" without one.
export function clientIp(req: Request): string {
  const first = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return (first || req.headers.get("x-real-ip") || "unknown").slice(0, 64);
}

// Maps a verifyPin result to the error response every PIN-gated endpoint returns, or null on "ok".
export function pinErrorResponse(result: VerifyResult): Response | null {
  if (result === "too_many_attempts") return errorResponse(429, "too_many_attempts", "Too many wrong PINs; try again in a minute");
  if (result === "wrong_pin") return errorResponse(403, "wrong_pin", "That PIN is not the current IT PIN");
  return null;
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
