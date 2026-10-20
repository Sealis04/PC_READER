import type { Db } from "@/db";
import { jsonResponse } from "@/lib/http";
import { clientIp, currentPin, rotateNow, type CurrentPin } from "@/lib/it-pin";
import { recordStaffEvent } from "@/lib/staff-events";

const body = (c: CurrentPin) => ({ pin: c.pin, expires_at: c.expiresAt.toISOString() });

// GET /api/dashboard/it-pin — the current IT PIN and when it changes.
export async function handleGetPin(db: Db): Promise<Response> {
  return jsonResponse(body(await currentPin(db)));
}

// POST /api/dashboard/it-pin — "Change now": rotates the PIN immediately and logs who did it (never the PIN).
export async function handleRotatePin(req: Request, db: Db, staffId: string | null = null): Promise<Response> {
  const pin = await rotateNow(db);
  await recordStaffEvent(db, { type: "it_pin_rotated", staffUserId: staffId, clientIp: clientIp(req) });
  return jsonResponse(body(pin));
}
