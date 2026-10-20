import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { desc, eq } from "drizzle-orm";
import { closeDb, getDb } from "@/db";
import { staffEvents, staffSession, staffUser } from "@/db/schema";
import { getAuth, handleAuthRequest, resetAuthForTests } from "@/lib/auth";
import { allowedLevels, authConfigured, isAllowedLevel, safeNext } from "@/lib/staff-config";
import { prepareDatabase, resetDatabase } from "./helpers";

const BASE = "http://pcreader.test";
let hris: ReturnType<typeof Bun.serve>;
// What the mock HRIS puts into the next id_token.
let claims: Record<string, unknown> = {};

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

beforeAll(async () => {
  await prepareDatabase();
  hris = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const origin = url.origin;
      if (url.pathname === "/.well-known/openid-configuration") {
        return Response.json({
          issuer: `${origin}/api/better-auth`,
          authorization_endpoint: `${origin}/api/better-auth/oauth2/authorize`,
          token_endpoint: `${origin}/api/better-auth/oauth2/token`,
          userinfo_endpoint: `${origin}/api/better-auth/oauth2/userinfo`,
          jwks_uri: `${origin}/api/better-auth/jwks`,
        });
      }
      if (url.pathname === "/api/better-auth/oauth2/token") {
        const id_token = `${b64({ alg: "none" })}.${b64({ iss: `${origin}/api/better-auth`, aud: "pcreader", ...claims })}.sig`;
        return Response.json({ access_token: "at", token_type: "Bearer", expires_in: 3600, id_token, scope: "openid profile email account_level" });
      }
      return new Response("not found", { status: 404 });
    },
  });
  process.env.BETTER_AUTH_SECRET = "test-secret-test-secret-test-secret-1234";
  process.env.BETTER_AUTH_URL = BASE;
  process.env.HRIS_URL = `http://localhost:${hris.port}`;
  process.env.HRIS_CLIENT_ID = "pcreader";
  process.env.HRIS_CLIENT_SECRET = "shh";
  delete process.env.HRIS_ALLOWED_USER_LEVELS;
  resetAuthForTests();
});
beforeEach(resetDatabase);
afterAll(async () => {
  hris.stop(true);
  await closeDb();
});

// Walks sign-in → HRIS → callback with the mock; returns the callback response.
async function signIn(profile: Record<string, unknown>): Promise<Response> {
  claims = profile;
  const auth = getAuth()!;
  const start = await auth.handler(
    new Request(`${BASE}/api/auth/sign-in/oauth2`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify({ providerId: "hris", callbackURL: "/devices", errorCallbackURL: "/login" }),
    }),
  );
  expect(start.status).toBe(200);
  const { url } = (await start.json()) as { url: string };
  const authorize = new URL(url);
  expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
  expect(authorize.searchParams.get("scope")).toBe("openid profile email account_level");
  const cookie = start.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  return handleAuthRequest(auth, new Request(`${BASE}/api/auth/oauth2/callback/hris?code=abc&state=${authorize.searchParams.get("state")}`, { headers: { cookie } }));
}

const profile = (over: Record<string, unknown> = {}) => ({ sub: "hris-1", name: "Ira IT", email: "ira@example.gov", employee_number: "0042", "hris:user_level": "IT", ...over });
const events = () => getDb().select().from(staffEvents).orderBy(desc(staffEvents.createdAt));

describe("settings helpers", () => {
  test("isAllowedLevel: IT passes by default; EMPLOYEE, null and a missing claim do not", () => {
    expect(isAllowedLevel("IT", "IT")).toBe(true);
    expect(isAllowedLevel(" IT ", "IT")).toBe(true);
    expect(isAllowedLevel("EMPLOYEE", "IT")).toBe(false);
    expect(isAllowedLevel(null, "IT")).toBe(false);
    expect(isAllowedLevel(undefined, "IT")).toBe(false);
    expect(isAllowedLevel("", "")).toBe(false);
    expect(isAllowedLevel("it", "IT")).toBe(false);
  });
  test("a custom list", () => {
    expect(isAllowedLevel("HR", "IT, HR")).toBe(true);
    expect(isAllowedLevel("ADMIN", "IT, HR")).toBe(false);
    expect(allowedLevels({ HRIS_ALLOWED_USER_LEVELS: "IT, HR" })).toEqual(["IT", "HR"]);
    expect(allowedLevels({})).toEqual(["IT"]);
  });
  test("authConfigured needs all five settings", () => {
    const full = { BETTER_AUTH_SECRET: "a", BETTER_AUTH_URL: "b", HRIS_URL: "c", HRIS_CLIENT_ID: "d", HRIS_CLIENT_SECRET: "e" };
    expect(authConfigured(full)).toBe(true);
    for (const k of Object.keys(full)) expect(authConfigured({ ...full, [k]: "" })).toBe(false);
    expect(authConfigured({})).toBe(false);
  });
  test("safeNext keeps same-origin paths only", () => {
    expect(safeNext("/devices/1?x=2")).toBe("/devices/1?x=2");
    for (const bad of ["//evil.com", "https://evil.com", "/\\evil.com", "evil", "", null, undefined, 5]) expect(safeNext(bad)).toBe("/devices");
  });
});

describe("HRIS sign-in", () => {
  test("an IT user gets a session, a staff row and a login event", async () => {
    const res = await signIn(profile());
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/devices");
    expect(res.headers.getSetCookie().join(";")).toContain("session_token");
    const [staff] = await getDb().select().from(staffUser);
    expect(staff).toMatchObject({ hrisSub: "hris-1", name: "Ira IT", employeeNumber: "0042", hrisUserLevel: "IT" });
    expect(await getDb().select().from(staffSession)).toHaveLength(1);
    expect((await events()).map((e) => e.type)).toEqual(["login"]);
  });

  test("an EMPLOYEE gets no session and a login_denied event", async () => {
    const res = await signIn(profile({ "hris:user_level": "EMPLOYEE" }));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${BASE}/login?error=not_allowed`);
    expect(res.headers.getSetCookie().join(";")).not.toContain("session_token");
    expect(await getDb().select().from(staffSession)).toHaveLength(0);
    const [e] = await events();
    expect(e.type).toBe("login_denied");
    expect(e.hrisSub).toBe("hris-1");
  });

  test("a token without the user level claim is denied", async () => {
    const res = await signIn(profile({ "hris:user_level": undefined }));
    expect(res.headers.getSetCookie().join(";")).not.toContain("session_token");
    expect((await events())[0].type).toBe("login_denied");
  });

  test("a level change in HRIS is picked up at the next sign-in", async () => {
    await signIn(profile());
    await getDb().delete(staffSession);
    const denied = await signIn(profile({ "hris:user_level": "EMPLOYEE" }));
    expect(denied.headers.getSetCookie().join(";")).not.toContain("session_token");
    expect((await getDb().select().from(staffUser).where(eq(staffUser.hrisSub, "hris-1")))[0].hrisUserLevel).toBe("EMPLOYEE");
    const again = await signIn(profile());
    expect(again.headers.getSetCookie().join(";")).toContain("session_token");
    expect((await getDb().select().from(staffUser)).length).toBe(1);
    expect((await events()).map((e) => e.type).sort()).toEqual(["login", "login", "login_denied"]);
  });
});
