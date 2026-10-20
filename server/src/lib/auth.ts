import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { genericOAuth } from "better-auth/plugins";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { staffAccount, staffSession, staffUser, staffVerification } from "@/db/schema";
import { clientIp } from "@/lib/it-pin";
import { allowedLevels, authConfigured, isAllowedLevel, SESSION_SECONDS } from "@/lib/staff-config";
import { recordStaffEvent } from "@/lib/staff-events";

export const HRIS_PROVIDER_ID = "hris";
export const HRIS_SCOPES = ["openid", "profile", "email", "account_level"];
export const NOT_ALLOWED_CODE = "NOT_ALLOWED";

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);

// HRIS claims → staff_user columns. `hris:user_level` only arrives with the account_level scope; a missing
// claim is stored as null, which is never allowed.
export function mapHrisProfile(profile: Record<string, unknown>) {
  return {
    hrisSub: String(profile.sub ?? profile.id ?? ""),
    employeeNumber: str(profile.employee_number) ?? null,
    hrisUserLevel: str(profile["hris:user_level"]) ?? null,
  };
}

function createAuth() {
  const baseURL = process.env.BETTER_AUTH_URL!.trim().replace(/\/+$/, "");
  const hris = process.env.HRIS_URL!.trim().replace(/\/+$/, "");
  const db = getDb();
  return betterAuth({
    appName: "PC_READER",
    baseURL,
    secret: process.env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: { user: staffUser, session: staffSession, account: staffAccount, verification: staffVerification },
    }),
    // Only HRIS: no local passwords.
    emailAndPassword: { enabled: false },
    user: {
      additionalFields: {
        hrisSub: { type: "string", required: true, unique: true, input: false },
        employeeNumber: { type: "string", required: false, input: false },
        hrisUserLevel: { type: "string", required: false, input: false },
      },
    },
    session: { expiresIn: SESSION_SECONDS, updateAge: 60 * 60 },
    account: { accountLinking: { enabled: false } },
    advanced: {
      useSecureCookies: baseURL.startsWith("https://"),
      database: { generateId: () => crypto.randomUUID() },
    },
    onAPIError: { errorURL: "/login" },
    plugins: [
      genericOAuth({
        config: [
          {
            providerId: HRIS_PROVIDER_ID,
            discoveryUrl: `${hris}/.well-known/openid-configuration`,
            clientId: process.env.HRIS_CLIENT_ID!,
            clientSecret: process.env.HRIS_CLIENT_SECRET!,
            pkce: true,
            scopes: HRIS_SCOPES,
            // The level is refreshed from HRIS at every sign-in.
            overrideUserInfo: true,
            // The extra columns are not on Better Auth's base User type.
            mapProfileToUser: (profile) => mapHrisProfile(profile) as never,
          },
        ],
      }),
      nextCookies(),
    ],
    databaseHooks: {
      session: {
        create: {
          // The gate: only allowed HRIS user levels get a session.
          before: async (session, ctx) => {
            const [staff] = await db.select().from(staffUser).where(eq(staffUser.id, session.userId)).limit(1);
            const ip = ctx?.request ? clientIp(ctx.request) : null;
            if (!staff || !isAllowedLevel(staff.hrisUserLevel, allowedLevels().join(","))) {
              await recordStaffEvent(db, {
                type: "login_denied",
                staffUserId: staff?.id,
                hrisSub: staff?.hrisSub,
                detail: `HRIS user level ${staff?.hrisUserLevel ?? "(none)"} is not allowed`,
                clientIp: ip,
              });
              throw new APIError("FORBIDDEN", { message: "Your HRIS account is not allowed to use PC_READER", code: NOT_ALLOWED_CODE });
            }
            await recordStaffEvent(db, { type: "login", staffUserId: staff.id, hrisSub: staff.hrisSub, clientIp: ip });
          },
        },
      },
    },
    hooks: {
      // Sign out is logged before the session disappears.
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/sign-out") return;
        const token = await ctx.getSignedCookie(ctx.context.authCookies.sessionToken.name, ctx.context.secret);
        if (!token) return;
        const found = await ctx.context.internalAdapter.findSession(token);
        if (!found) return;
        await recordStaffEvent(db, { type: "logout", staffUserId: found.user.id, hrisSub: (found.user as { hrisSub?: string }).hrisSub, clientIp: ctx.request ? clientIp(ctx.request) : null });
      }),
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
let instance: Auth | undefined;

// Null when the login settings are missing (the caller fails closed). Created lazily so importing
// route modules needs neither the database nor these settings.
export function getAuth(): Auth | null {
  if (!authConfigured()) return null;
  return (instance ??= createAuth());
}

export function resetAuthForTests(): void {
  instance = undefined;
}

// Better Auth's HTTP handler, plus one rewrite: a callback refused by the user-level gate becomes a redirect
// to /login?error=not_allowed (the browser is mid-redirect from HRIS, so a JSON 403 would be a dead end).
export async function handleAuthRequest(auth: Auth, req: Request): Promise<Response> {
  const res = await auth.handler(req);
  if (res.status === 403 && new URL(req.url).pathname.includes("/oauth2/callback/")) {
    const body = (await res.clone().json().catch(() => null)) as { code?: string } | null;
    if (body?.code === NOT_ALLOWED_CODE) {
      return new Response(null, { status: 302, headers: { location: new URL("/login?error=not_allowed", process.env.BETTER_AUTH_URL).toString(), "cache-control": "no-store" } });
    }
  }
  return res;
}
