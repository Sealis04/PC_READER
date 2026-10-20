import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { RegisterResponse } from "@pcreader/contracts";
import { desc, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { closeDb, getDb } from "@/db";
import { deviceFieldHistory, deviceRequests, staffEvents, staffUser, statusHistory } from "@/db/schema";
import { handleRegister } from "@/lib/agent/register";
import { getDeviceHistory } from "@/lib/queries";
import { isOpenPath, proxy } from "@/proxy";
import { jsonRequest, prepareDatabase, registerFixture, resetDatabase } from "./helpers";
import { hrisProfile, sessionCookie, signIn, startMockHris, stopMockHris } from "./mock-hris";

const ROUTE_DIR = `${import.meta.dir}/../src/app/api/dashboard`;
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
const ID = "11111111-1111-4111-8111-111111111111";
const AUTH_ENV = ["BETTER_AUTH_SECRET", "BETTER_AUTH_URL", "HRIS_URL", "HRIS_CLIENT_ID", "HRIS_CLIENT_SECRET"] as const;

beforeAll(async () => {
  await prepareDatabase();
  startMockHris();
});
beforeEach(resetDatabase);
afterAll(async () => {
  stopMockHris();
  await closeDb();
});

type Handler = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

// Every exported method of every src/app/api/dashboard/**/route.ts.
async function dashboardHandlers(): Promise<Array<{ file: string; method: string; handler: Handler }>> {
  const out: Array<{ file: string; method: string; handler: Handler }> = [];
  for (const file of new Bun.Glob("**/route.ts").scanSync(ROUTE_DIR)) {
    const mod = (await import(`${ROUTE_DIR}/${file}`)) as Record<string, unknown>;
    for (const method of METHODS) if (typeof mod[method] === "function") out.push({ file, method, handler: mod[method] as Handler });
  }
  return out;
}

const call = (h: Handler, method: string, headers: Record<string, string> = {}) =>
  h(new Request("http://pcreader.test/api/dashboard/x", { method, headers: { "content-type": "application/json", ...headers }, body: method === "GET" || method === "DELETE" ? undefined : "{}" }), { params: Promise.resolve({ id: ID }) });

describe("dashboard API sweep", () => {
  test("finds the dashboard routes", async () => {
    const files = new Set((await dashboardHandlers()).map((h) => h.file));
    expect([...files].sort()).toEqual(["devices/[id]/inventory/route.ts", "devices/[id]/requests/route.ts", "it-pin/route.ts", "settings/logo/route.ts", "settings/route.ts"]);
  });

  test("every route and method answers 401 without a session", async () => {
    for (const { file, method, handler } of await dashboardHandlers()) {
      const res = await call(handler, method);
      expect([file, method, res.status]).toEqual([file, method, 401]);
      expect(await res.json()).toMatchObject({ error: "unauthorized" });
    }
  });

  test("a forged session cookie gets nowhere", async () => {
    for (const { file, method, handler } of await dashboardHandlers()) {
      const res = await call(handler, method, { cookie: "better-auth.session_token=forged.value" });
      expect([file, method, res.status]).toEqual([file, method, 401]);
    }
  });

  test("every route answers 503 when the login settings are missing", async () => {
    const saved = Object.fromEntries(AUTH_ENV.map((k) => [k, process.env[k]]));
    try {
      for (const k of AUTH_ENV) {
        for (const other of AUTH_ENV) process.env[other] = saved[other];
        delete process.env[k];
        for (const { file, method, handler } of await dashboardHandlers()) {
          const res = await call(handler, method);
          expect([k, file, method, res.status]).toEqual([k, file, method, 503]);
          expect(await res.json()).toMatchObject({ error: "not_configured" });
        }
      }
    } finally {
      for (const k of AUTH_ENV) process.env[k] = saved[k];
    }
  });

  test("with a session the same routes get past the gate", async () => {
    const cookie = sessionCookie(await signIn());
    for (const { file, method, handler } of await dashboardHandlers()) {
      if (method !== "GET") continue;
      const res = await call(handler, method, { cookie });
      expect([file, res.status === 401 || res.status === 503]).toEqual([file, false]);
    }
  });

  test("a staff level removed from HRIS_ALLOWED_USER_LEVELS locks existing sessions out", async () => {
    const cookie = sessionCookie(await signIn());
    process.env.HRIS_ALLOWED_USER_LEVELS = "HR";
    try {
      const { GET } = (await import(`${ROUTE_DIR}/it-pin/route.ts`)) as { GET: Handler };
      expect((await call(GET, "GET", { cookie })).status).toBe(401);
    } finally {
      delete process.env.HRIS_ALLOWED_USER_LEVELS;
    }
  });
});

describe("agent and branding stay open", () => {
  test("paths", () => {
    for (const p of ["/login", "/api/auth/sign-in/oauth2", "/api/agent/register", "/api/agent/events", "/api/branding", "/api/branding/logo"]) expect(isOpenPath(p)).toBe(true);
    for (const p of ["/", "/devices", "/devices/1", "/it-pin", "/settings", "/api/dashboard/it-pin", "/api/dashboardx", "/loginx", "/api/agentx"]) expect(isOpenPath(p)).toBe(false);
  });

  test("the branding route works without a staff session", async () => {
    const { GET } = (await import("@/app/api/branding/route")) as { GET: (req: Request) => Promise<Response> };
    expect((await GET(new Request("http://pcreader.test/api/branding"))).status).toBe(200);
  });

  test("the agent register route answers on its own rules (no staff session needed)", async () => {
    const { POST } = (await import("@/app/api/agent/register/route")) as { POST: (req: Request) => Promise<Response> };
    const res = await POST(jsonRequest("/api/agent/register", { nonsense: true }));
    expect(res.status).toBe(400);
  });
});

describe("proxy", () => {
  const req = (path: string, cookie?: string) => new NextRequest(`http://pcreader.test${path}`, { headers: cookie ? { cookie } : {} });

  test("pages without a cookie redirect to /login with next", () => {
    const res = proxy(req("/devices/abc?level=error"));
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location")!).pathname + new URL(res.headers.get("location")!).search).toBe("/login?next=%2Fdevices%2Fabc%3Flevel%3Derror");
  });
  test("the home page redirects without next", () => {
    expect(new URL(proxy(req("/")).headers.get("location")!).search).toBe("");
  });
  test("dashboard API without a cookie is 401 JSON, not a redirect", async () => {
    const res = proxy(req("/api/dashboard/it-pin"));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "unauthorized" });
  });
  test("a cookie lets the request through to the server-side check", () => {
    const res = proxy(req("/devices", "better-auth.session_token=x.y"));
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });
  test("open paths pass without a cookie", () => {
    for (const p of ["/login", "/api/agent/scans", "/api/branding", "/api/auth/get-session"]) expect(proxy(req(p)).headers.get("x-middleware-next")).toBe("1");
  });
});

async function newDevice(hostname: string): Promise<string> {
  const body = { ...registerFixture("windows-desktop"), device_uuid: crypto.randomUUID(), hostname };
  const res = await handleRegister(jsonRequest("/api/agent/register", { ...body, user: { ...body.user, employee_id: `E-${hostname}` } }), getDb());
  return ((await res.json()) as RegisterResponse).device_id;
}

describe("who did it", () => {
  async function asStaff() {
    const cookie = sessionCookie(await signIn(hrisProfile({ name: "Ira IT" })));
    const [staff] = await getDb().select().from(staffUser);
    const post = async (file: string, body: unknown, id = ID) => {
      const { POST } = (await import(`${ROUTE_DIR}/${file}`)) as { POST: Handler };
      return POST(new Request("http://pcreader.test/api/dashboard/x", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
    };
    return { staff, post, cookie };
  }

  test("status, location and number changes carry the staff id; history shows the name", async () => {
    const id = await newDevice("PC-1");
    const { staff, post } = await asStaff();
    expect((await post("devices/[id]/inventory/route.ts", { action: "set_status", status: "spare", reason: "returned" }, id)).status).toBe(200);
    expect((await post("devices/[id]/inventory/route.ts", { action: "set_location", value: "Room 2" }, id)).status).toBe(200);
    expect((await post("devices/[id]/inventory/route.ts", { action: "assign_next" }, id)).status).toBe(200);
    expect((await getDb().select().from(statusHistory))[0].changedBy).toBe(staff.id);
    expect((await getDb().select().from(deviceFieldHistory)).map((r) => r.changedBy)).toEqual([staff.id, staff.id]);
    const history = await getDeviceHistory(getDb(), id);
    const changes = history.filter((h) => h.kind !== "assigned");
    expect(changes).toHaveLength(3);
    expect(changes.every((h) => h.by === "Ira IT")).toBe(true);
  });

  test("older rows keep their stored text", async () => {
    const id = await newDevice("PC-2");
    await getDb().insert(statusHistory).values({ deviceId: id, oldStatus: "in_use", newStatus: "spare", changedBy: "someone-before-login" });
    const history = await getDeviceHistory(getDb(), id);
    expect(history.find((h) => h.kind === "status")?.by).toBe("someone-before-login");
    expect(history.find((h) => h.kind === "assigned")?.by).toBe("self-registration");
  });

  test("a queued request records the staff id", async () => {
    const id = await newDevice("PC-3");
    const { staff, post } = await asStaff();
    expect((await post("devices/[id]/requests/route.ts", { type: "scan_now" }, id)).status).toBe(201);
    expect((await getDb().select().from(deviceRequests))[0].requestedBy).toBe(staff.id);
  });

  test("IT PIN rotation, settings and logo changes are logged without secrets", async () => {
    const { staff, post, cookie } = await asStaff();
    const pinBefore = await (await (await import(`${ROUTE_DIR}/it-pin/route.ts`)).GET(new Request("http://pcreader.test/x", { headers: { cookie } }))).json();
    const rotated = await (await post("it-pin/route.ts", {})).json();
    expect(rotated.pin).not.toBe(pinBefore.pin);
    expect((await post("settings/route.ts", { agency_name: "Test Agency" })).status).toBe(200);
    const { POST: setLogo, DELETE: clearLogo } = (await import(`${ROUTE_DIR}/settings/logo/route.ts`)) as { POST: Handler; DELETE: Handler };
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
    expect((await setLogo(new Request("http://pcreader.test/x", { method: "POST", headers: { "content-type": "image/png", cookie }, body: png }), { params: Promise.resolve({ id: ID }) })).status).toBe(200);
    expect((await clearLogo(new Request("http://pcreader.test/x", { method: "DELETE", headers: { cookie } }), { params: Promise.resolve({ id: ID }) })).status).toBe(200);
    const rows = await getDb().select().from(staffEvents).orderBy(desc(staffEvents.createdAt));
    expect(rows.map((r) => r.type).sort()).toEqual(["it_pin_rotated", "login", "logo_changed", "logo_changed", "settings_changed"]);
    for (const r of rows.filter((x) => x.type !== "login")) expect(r.staffUserId).toBe(staff.id);
    expect(JSON.stringify(rows)).not.toContain(rotated.pin);
    expect(await getDb().select().from(staffUser).where(eq(staffUser.id, staff.id))).toHaveLength(1);
  });
});
