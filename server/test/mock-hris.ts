import { getAuth, handleAuthRequest, resetAuthForTests } from "@/lib/auth";

export const BASE = "http://pcreader.test";
let hris: ReturnType<typeof Bun.serve> | undefined;
// What the mock HRIS puts into the next id_token.
let claims: Record<string, unknown> = {};

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

// A tiny HRIS: OIDC discovery and a token endpoint that returns an id_token with the claims set by signIn.
// (Better Auth reads the claims from the id_token it got over the back channel; the signature is not checked.)
export function startMockHris(): void {
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
}

export function stopMockHris(): void {
  hris?.stop(true);
}

export const hrisProfile = (over: Record<string, unknown> = {}) => ({ sub: "hris-1", name: "Ira IT", email: "ira@example.gov", employee_number: "0042", "hris:user_level": "IT", ...over });

// Walks sign-in → HRIS → callback with the mock; returns the callback response.
export async function signIn(profile: Record<string, unknown> = hrisProfile()): Promise<Response> {
  claims = profile;
  const auth = getAuth()!;
  const start = await auth.handler(
    new Request(`${BASE}/api/auth/sign-in/oauth2`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify({ providerId: "hris", callbackURL: "/devices", errorCallbackURL: "/login" }),
    }),
  );
  if (start.status !== 200) throw new Error(`sign-in start failed: ${start.status}`);
  const { url } = (await start.json()) as { url: string };
  const authorize = new URL(url);
  const cookie = start.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const res = await handleAuthRequest(auth, new Request(`${BASE}/api/auth/oauth2/callback/hris?code=abc&state=${authorize.searchParams.get("state")}`, { headers: { cookie } }));
  authorizeParams = authorize.searchParams;
  return res;
}

// The query string of the last authorize redirect (PKCE and scope checks).
export let authorizeParams: URLSearchParams | undefined;

// The Cookie header value for a successful sign-in response.
export const sessionCookie = (res: Response): string => res.headers.getSetCookie().map((c) => c.split(";")[0]).filter((c) => c.includes("session_token")).join("; ");
