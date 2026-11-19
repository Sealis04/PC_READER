import type { MoveFailureReason } from "@pcreader/contracts";
import { and, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import type { Db } from "@/db";
import { devices, serverMoveResults, serverMoves, type ServerMove } from "@/db/schema";
import { verifyPin, type VerifyResult } from "@/lib/it-pin";
import { broadcast } from "@/lib/notifier";

// Server move (M7): IT enters the new address on the dashboard (with the IT PIN). While the move is active
// every connected PC, and every PC that connects later, is told the address; a PC switches only after the
// new address recognises its token as the same device, and reports the outcome here first.

export const MOVE_REASON_LABEL: Record<MoveFailureReason, string> = {
  unreachable: "the new address did not answer",
  unknown_device: "the new address does not know this PC",
  different_device: "the new address knows the token as another PC",
  invalid_url: "the address could not be used",
};

export class MoveError extends Error {
  constructor(
    public readonly status: 400 | 403 | 404 | 429,
    public readonly code: "invalid_payload" | "wrong_pin" | "too_many_attempts" | "not_found",
    message: string,
  ) {
    super(message);
  }
}

function refused(result: Exclude<VerifyResult, "ok">): MoveError {
  return result === "too_many_attempts"
    ? new MoveError(429, "too_many_attempts", "Too many wrong PINs; try again in a minute")
    : new MoveError(403, "wrong_pin", "That PIN is not the current IT PIN");
}

// The contract's url pattern: http(s), a host, optional port and path; no query, fragment or credentials.
const URL_RE = /^https?:\/\/[^\s/?#]+(\/[^\s?#]*)?$/;

export function normalizeMoveUrl(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) throw new MoveError(400, "invalid_payload", "Enter the new server address, e.g. http://pcreader.office.local:3000");
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new MoveError(400, "invalid_payload", "That is not a valid address (e.g. http://192.168.1.20:3000)");
  }
  if ((u.protocol !== "http:" && u.protocol !== "https:") || !u.hostname) throw new MoveError(400, "invalid_payload", "The address must start with http:// or https://");
  if (u.username || u.password || u.search || u.hash) throw new MoveError(400, "invalid_payload", "The address must not contain a user name, password, ? or #");
  const out = u.toString().replace(/\/+$/, "");
  if (!URL_RE.test(out) || out.length > 2048) throw new MoveError(400, "invalid_payload", "That address cannot be used");
  return out;
}

export async function activeMove(db: Db): Promise<ServerMove | null> {
  const [row] = await db.select().from(serverMoves).where(isNull(serverMoves.endedAt)).orderBy(desc(serverMoves.createdAt)).limit(1);
  return row ?? null;
}

// Starts a move (ending any active one) and tells every open stream. Needs the current IT PIN.
export async function startMove(db: Db, rawUrl: unknown, pin: unknown, clientIp: string, now = new Date()): Promise<ServerMove> {
  const url = normalizeMoveUrl(rawUrl);
  const result = await verifyPin(db, { deviceId: null, clientIp }, typeof pin === "string" ? pin.trim() : "", "server_move", now);
  if (result !== "ok") throw refused(result);
  const row = await db.transaction(async (tx) => {
    await tx.update(serverMoves).set({ endedAt: now }).where(isNull(serverMoves.endedAt));
    const [m] = await tx.insert(serverMoves).values({ url, clientIp, createdAt: now }).returning();
    return m;
  });
  broadcast("server_move");
  return row;
}

// "Cancel move": PCs that already switched stay on the new address; the others are no longer told.
export async function cancelMove(db: Db, now = new Date()): Promise<boolean> {
  const ended = await db.update(serverMoves).set({ endedAt: now }).where(isNull(serverMoves.endedAt)).returning({ id: serverMoves.id });
  return ended.length > 0;
}

// The PC's report (sent to this, the old server). False when the move is unknown.
export async function recordMoveResult(db: Db, deviceId: string, moveId: string, moved: boolean, reason: MoveFailureReason | null): Promise<boolean> {
  const [move] = await db.select({ id: serverMoves.id }).from(serverMoves).where(eq(serverMoves.id, moveId));
  if (!move) return false;
  await db.insert(serverMoveResults).values({ moveId, deviceId, moved, reason: moved ? null : reason });
  return true;
}

// Whether this device should be told about the active move: not once it reported that it moved.
export async function moveForDevice(db: Db, deviceId: string): Promise<ServerMove | null> {
  const move = await activeMove(db);
  if (!move) return null;
  const [done] = await db
    .select({ id: serverMoveResults.id })
    .from(serverMoveResults)
    .where(and(eq(serverMoveResults.moveId, move.id), eq(serverMoveResults.deviceId, deviceId), eq(serverMoveResults.moved, true)))
    .limit(1);
  return done ? null : move;
}

export type DeviceMoveState = { state: "moved" } | { state: "not_moved"; reason: MoveFailureReason | null; at: Date } | { state: "waiting" };

// Latest report per device for a move: moved (any success), else the newest failure, else waiting.
export async function deviceMoveStates(db: Db, moveId: string, deviceIds?: string[]): Promise<Map<string, DeviceMoveState>> {
  const rows = await db
    .select()
    .from(serverMoveResults)
    .where(and(eq(serverMoveResults.moveId, moveId), deviceIds ? inArray(serverMoveResults.deviceId, deviceIds) : undefined))
    .orderBy(desc(serverMoveResults.createdAt));
  const out = new Map<string, DeviceMoveState>();
  for (const r of rows) {
    const prev = out.get(r.deviceId);
    if (r.moved) out.set(r.deviceId, { state: "moved" });
    else if (!prev) out.set(r.deviceId, { state: "not_moved", reason: r.reason as MoveFailureReason | null, at: r.createdAt });
  }
  return out;
}

export function moveStateLabel(s: DeviceMoveState | undefined): string {
  if (!s || s.state === "waiting") return "waiting (has not connected since the move started)";
  if (s.state === "moved") return "moved";
  return `not moved: ${s.reason ? MOVE_REASON_LABEL[s.reason] : "no reason given"}`;
}

export interface MoveSummary {
  move: ServerMove;
  moved: number;
  notMoved: Array<{ deviceId: string; hostname: string; reason: MoveFailureReason | null; at: Date }>;
  waiting: number;
}

// The Settings card: the active move and how far the registered PCs got.
export async function moveSummary(db: Db): Promise<MoveSummary | null> {
  const move = await activeMove(db);
  if (!move) return null;
  const registered = await db.select({ id: devices.id, hostname: devices.hostname }).from(devices).where(isNotNull(devices.tokenHash));
  const states = await deviceMoveStates(db, move.id);
  const out: MoveSummary = { move, moved: 0, notMoved: [], waiting: 0 };
  for (const d of registered) {
    const s = states.get(d.id);
    if (s?.state === "moved") out.moved++;
    else if (s?.state === "not_moved") out.notMoved.push({ deviceId: d.id, hostname: d.hostname, reason: s.reason, at: s.at });
    else out.waiting++;
  }
  out.notMoved.sort((a, b) => a.hostname.localeCompare(b.hostname));
  return out;
}
