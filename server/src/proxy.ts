import { getSessionCookie } from "better-auth/cookies";
import { NextResponse, type NextRequest } from "next/server";
import { authConfigured } from "@/lib/staff-config";

// Open to everyone: the login page, Better Auth's endpoints, the PC agent API (device tokens) and the
// public branding the desktop app needs. Everything else is the staff dashboard.
export const OPEN_PREFIXES = ["/login", "/api/auth", "/api/agent", "/api/branding"];

export const isOpenPath = (pathname: string): boolean => OPEN_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));

// Cheap first gate: no session cookie, no dashboard. The real check (a valid, allowed session) happens
// server-side in requireStaff / requireStaffApi, so a forged cookie gets nowhere.
export function proxy(req: NextRequest): NextResponse {
  const { pathname, search } = req.nextUrl;
  if (isOpenPath(pathname)) return NextResponse.next();
  if (pathname.startsWith("/api/")) {
    if (!authConfigured()) return NextResponse.json({ error: "not_configured", message: "Login is not configured" }, { status: 503, headers: { "cache-control": "no-store" } });
    if (!getSessionCookie(req)) return NextResponse.json({ error: "unauthorized", message: "Sign in with HRIS to use the dashboard" }, { status: 401, headers: { "cache-control": "no-store" } });
    return NextResponse.next();
  }
  if (getSessionCookie(req)) return NextResponse.next();
  const login = new URL("/login", req.url);
  if (authConfigured() && pathname !== "/") login.searchParams.set("next", `${pathname}${search}`);
  return NextResponse.redirect(login);
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
