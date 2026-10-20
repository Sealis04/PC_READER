import { getDb } from "@/db";
import { requireStaffApi } from "@/lib/staff-auth";
import { jsonResponse } from "@/lib/http";
import { currentPin, rotateNow } from "@/lib/it-pin";

export const dynamic = "force-dynamic";

const body = (c: { pin: string; expiresAt: Date }) => ({ pin: c.pin, expires_at: c.expiresAt.toISOString() });

// GET /api/dashboard/it-pin — the current IT PIN and when it changes.
export async function GET(req: Request): Promise<Response> {
  const staff = await requireStaffApi(req);
  if (staff instanceof Response) return staff;
  return jsonResponse(body(await currentPin(getDb())));
}

// POST /api/dashboard/it-pin — "Change now": rotates the PIN immediately. No staff login yet.
export async function POST(req: Request): Promise<Response> {
  const staff = await requireStaffApi(req);
  if (staff instanceof Response) return staff;
  return jsonResponse(body(await rotateNow(getDb())));
}
