import { formatErrors, validateUserRequest, type UserDetails } from "@pcreader/contracts";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@/db";
import { assignments, users } from "@/db/schema";
import { authenticateDevice } from "@/lib/agent/auth";
import { HttpError, errorResponse, jsonResponse, readJson } from "@/lib/http";

export const SELF_SERVICE = "self-service";

// PUT /api/agent/user — the signed-in device's user corrects their details or hands the PC to someone else.
// Same employee_id as the open assignment: update that user. Different employee_id: upsert that user,
// close the old assignment and open a new one.
export async function handleUserUpdate(req: Request, db: Db): Promise<Response> {
  const device = await authenticateDevice(req, db);
  if (!device) return errorResponse(401, "unauthorized", "Missing or invalid device token");

  let body: unknown;
  try {
    body = await readJson(req);
  } catch (e) {
    if (e instanceof HttpError) return e.response;
    throw e;
  }
  if (!validateUserRequest(body)) {
    return errorResponse(400, "invalid_payload", "Request does not match user.request schema", formatErrors(validateUserRequest.errors));
  }

  const now = new Date();
  const fields = { fullName: body.full_name, email: body.email, department: body.department, position: body.position, phone: body.phone };

  const stored = await db.transaction(async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({ employeeId: body.employee_id, ...fields })
      .onConflictDoUpdate({ target: users.employeeId, set: { ...fields, updatedAt: now } })
      .returning();

    const [open] = await tx
      .select({ id: assignments.id, userId: assignments.userId })
      .from(assignments)
      .where(and(eq(assignments.deviceId, device.id), isNull(assignments.endAt)))
      .for("update");
    if (!open || open.userId !== user.id) {
      if (open) {
        await tx.update(assignments).set({ endAt: now, updatedAt: now }).where(eq(assignments.id, open.id));
      }
      await tx.insert(assignments).values({ deviceId: device.id, userId: user.id, startAt: now, assignedBy: SELF_SERVICE });
    }
    return user;
  });

  const response: UserDetails = {
    full_name: stored.fullName,
    employee_id: stored.employeeId,
    email: stored.email,
    department: stored.department,
    position: stored.position,
    phone: stored.phone,
  };
  return jsonResponse(response);
}
