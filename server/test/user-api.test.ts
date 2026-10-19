import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { validateUserRequest, type RegisterResponse, type UserDetails } from "@pcreader/contracts";
import { asc, eq, isNull } from "drizzle-orm";
import { closeDb, getDb } from "@/db";
import { assignments, users } from "@/db/schema";
import { handleRegister } from "@/lib/agent/register";
import { handleUserUpdate } from "@/lib/agent/user";
import { jsonRequest, loadFixture, prepareDatabase, registerFixture, resetDatabase } from "./helpers";

beforeAll(prepareDatabase);
beforeEach(resetDatabase);
afterAll(closeDb);

async function registerDevice(): Promise<string> {
  const res = await handleRegister(jsonRequest("/api/agent/register", registerFixture("windows-desktop")), getDb());
  return ((await res.json()) as RegisterResponse).device_token;
}

function putUser(token: string | null, body: unknown) {
  const req = jsonRequest("/api/agent/user", body, token ? { authorization: `Bearer ${token}` } : {});
  return handleUserUpdate(new Request(req, { method: "PUT" }), getDb());
}

const baseUser = () => loadFixture<UserDetails>("user/windows-desktop.json");
const allAssignments = () => getDb().select().from(assignments).orderBy(asc(assignments.startAt));

describe("PUT /api/agent/user", () => {
  test("updates the current user's details in place when employee_id is unchanged", async () => {
    const token = await registerDevice();
    const res = await putUser(token, { ...baseUser(), department: "Budget", position: null, phone: null });
    expect(res.status).toBe(200);
    const body = (await res.json()) as UserDetails;
    expect(validateUserRequest(body)).toBe(true);
    expect(body).toMatchObject({ employee_id: "EMP-0001", department: "Budget", position: null, phone: null });

    const [user] = await getDb().select().from(users);
    expect(user.department).toBe("Budget");
    expect(user.position).toBeNull();
    const rows = await allAssignments();
    expect(rows).toHaveLength(1);
    expect(rows[0].endAt).toBeNull();
    expect(rows[0].assignedBy).toBe("self-registration");
  });

  test("a different employee_id reassigns the device and records self-service", async () => {
    const token = await registerDevice();
    const res = await putUser(token, { ...baseUser(), full_name: "Maria Santos", employee_id: "EMP-0002", email: null });
    expect(res.status).toBe(200);

    expect(await getDb().select().from(users)).toHaveLength(2);
    const rows = await allAssignments();
    expect(rows).toHaveLength(2);
    expect(rows[0].endAt).toBeInstanceOf(Date);
    expect(rows[1].endAt).toBeNull();
    expect(rows[1].assignedBy).toBe("self-service");
    const [newUser] = await getDb().select().from(users).where(eq(users.id, rows[1].userId));
    expect(newUser.employeeId).toBe("EMP-0002");
    expect(await getDb().select().from(assignments).where(isNull(assignments.endAt))).toHaveLength(1);
  });

  test("moving to an existing employee reuses that user", async () => {
    const token = await registerDevice();
    await putUser(token, { ...baseUser(), employee_id: "EMP-0002" });
    await putUser(token, { ...baseUser(), employee_id: "EMP-0001" });
    expect(await getDb().select().from(users)).toHaveLength(2);
    expect(await allAssignments()).toHaveLength(3);
  });

  test("rejects a missing or unknown token with 401", async () => {
    await registerDevice();
    expect((await putUser(null, baseUser())).status).toBe(401);
    expect((await putUser("not-a-real-token", baseUser())).status).toBe(401);
  });

  test("rejects an invalid body with 400 and field details", async () => {
    const token = await registerDevice();
    const res = await putUser(token, { ...baseUser(), department: "" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_payload");
    expect(body.details.length).toBeGreaterThan(0);
    const [user] = await getDb().select().from(users);
    expect(user.department).toBe("Finance");
  });
});
