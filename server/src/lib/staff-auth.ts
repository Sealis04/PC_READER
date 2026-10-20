import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { getAuth } from "@/lib/auth";
import { errorResponse } from "@/lib/http";
import { allowedLevels, authConfigured, isAllowedLevel, safeNext } from "@/lib/staff-config";

export interface Staff {
  id: string;
  name: string;
  hrisSub: string;
}

async function staffFrom(requestHeaders: Headers): Promise<Staff | null> {
  const auth = getAuth();
  if (!auth) return null;
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session) return null;
  const user = session.user as typeof session.user & { hrisSub?: string; hrisUserLevel?: string | null };
  // The level was checked at sign-in; checking it again here also honours a narrowed HRIS_ALLOWED_USER_LEVELS.
  if (!user.hrisSub || !isAllowedLevel(user.hrisUserLevel, allowedLevels().join(","))) return null;
  return { id: user.id, name: user.name, hrisSub: user.hrisSub };
}

// The signed-in staff member for server components, or null (signed out or login not configured).
export async function getStaff(): Promise<Staff | null> {
  if (!authConfigured()) return null;
  return staffFrom(await headers());
}

// For dashboard pages and layouts: redirects to /login when there is no session.
export async function requireStaff(next?: string): Promise<Staff> {
  if (!authConfigured()) redirect("/login?error=not_configured");
  const staff = await getStaff();
  if (!staff) redirect(next ? `/login?next=${encodeURIComponent(safeNext(next))}` : "/login");
  return staff;
}

// For /api/dashboard route handlers: the staff member, or the 503 / 401 response to return as is.
export async function requireStaffApi(req: Request): Promise<Staff | Response> {
  if (!authConfigured()) return errorResponse(503, "not_configured", "Login is not configured");
  const staff = await staffFrom(req.headers);
  return staff ?? errorResponse(401, "unauthorized", "Sign in with HRIS to use the dashboard");
}
