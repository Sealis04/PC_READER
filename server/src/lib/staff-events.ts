import { desc, eq } from "drizzle-orm";
import type { Db } from "@/db";
import { staffEvents, staffUser } from "@/db/schema";

export type StaffEventType = (typeof staffEvents.$inferInsert)["type"];

export interface StaffEventInput {
  type: StaffEventType;
  staffUserId?: string | null;
  hrisSub?: string | null;
  detail?: string | null;
  clientIp?: string | null;
}

// Append-only. `detail` is a short human note; never put a token, code or the IT PIN in it.
export async function recordStaffEvent(db: Pick<Db, "insert">, e: StaffEventInput): Promise<void> {
  await db.insert(staffEvents).values({
    type: e.type,
    staffUserId: e.staffUserId ?? null,
    hrisSub: e.hrisSub ?? null,
    detail: e.detail?.slice(0, 500) ?? null,
    clientIp: e.clientIp ?? null,
  });
}

export const STAFF_ACTIVITY_LIMIT = 100;

export const EVENT_LABEL: Record<StaffEventType, string> = {
  login: "Signed in",
  login_denied: "Sign-in refused",
  logout: "Signed out",
  it_pin_rotated: "Changed the IT PIN",
  settings_changed: "Changed settings",
  logo_changed: "Changed the logo",
};

// The latest staff events, newest first, with the staff name when the event belongs to a known account.
export async function latestStaffEvents(db: Pick<Db, "select">, limit = STAFF_ACTIVITY_LIMIT) {
  return db
    .select({ id: staffEvents.id, at: staffEvents.createdAt, type: staffEvents.type, detail: staffEvents.detail, clientIp: staffEvents.clientIp, name: staffUser.name, hrisSub: staffEvents.hrisSub })
    .from(staffEvents)
    .leftJoin(staffUser, eq(staffUser.id, staffEvents.staffUserId))
    .orderBy(desc(staffEvents.createdAt))
    .limit(limit);
}
