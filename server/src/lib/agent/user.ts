import { formatErrors, validateUserRequest, type ConfirmApproval, type UserDetails } from "@pcreader/contracts";
import { and, eq, gte, inArray, isNull } from "drizzle-orm";
import type { Db } from "@/db";
import { assignments, deviceRequests, users } from "@/db/schema";
import { authenticateDevice } from "@/lib/agent/auth";
import { CONFIRM_APPROVAL_TTL_MS, approvalMatches, pinErrorResponse, recordAttempt, tooManyWrong, verifyPin } from "@/lib/it-pin";
import { HttpError, errorResponse, jsonResponse, readJson } from "@/lib/http";

export const SELF_SERVICE = "self-service";

const APPROVAL_INVALID = "This confirmation is no longer valid. IT needs to enter the PIN to save.";
const EMPLOYEE_ID_NEEDS_PIN = "Changing the employee ID needs the IT PIN.";

class Refused extends Error {
  constructor(readonly response: Response) {
    super("refused");
  }
}

// The employee ID of the device's current user, or null when the device has no open assignment.
async function currentEmployeeId(db: Db, deviceId: string): Promise<string | null> {
  const [row] = await db
    .select({ employeeId: users.employeeId })
    .from(assignments)
    .innerJoin(users, eq(users.id, assignments.userId))
    .where(and(eq(assignments.deviceId, deviceId), isNull(assignments.endAt)))
    .limit(1);
  return row?.employeeId ?? null;
}

// Checks IT's approval from a "confirm details" request: this device's, still open, under 24 hours old,
// with the right code, and the same employee ID as now. Returns the error response, or null when valid.
async function checkConfirm(db: Db, deviceId: string, confirm: ConfirmApproval, employeeId: string, now: Date): Promise<Response | null> {
  const [request] = await db
    .select({ id: deviceRequests.id })
    .from(deviceRequests)
    .where(
      and(
        eq(deviceRequests.id, confirm.request_id),
        eq(deviceRequests.deviceId, deviceId),
        eq(deviceRequests.type, "prompt_details_update"),
        inArray(deviceRequests.status, ["pending", "delivered"]),
        gte(deviceRequests.createdAt, new Date(now.getTime() - CONFIRM_APPROVAL_TTL_MS)),
      ),
    )
    .limit(1);
  if (!request || !(await approvalMatches(db, request.id, confirm.approval))) {
    return errorResponse(403, "approval_invalid", APPROVAL_INVALID);
  }
  if ((await currentEmployeeId(db, deviceId)) !== employeeId) {
    return errorResponse(403, "pin_required", EMPLOYEE_ID_NEEDS_PIN);
  }
  return null;
}

// PUT /api/agent/user — the signed-in device's user corrects their details or hands the PC to someone else.
// Same employee_id as the open assignment: update that user. Different employee_id: upsert that user,
// close the old assignment and open a new one.
//
// IT approves every save: with the hourly IT PIN, or, after IT pressed "Ask user to confirm details", with
// that request's approval code (confirm). The code is good for one save within 24 hours and cannot change
// the employee ID. Either way the save closes an open "confirm details" request.
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
  const subject = { deviceId: device.id };
  const confirm = body.it_pin === undefined ? body.confirm : undefined;
  if (confirm) {
    if (await tooManyWrong(db, subject, now)) return pinErrorResponse("too_many_attempts")!;
    const refused = await checkConfirm(db, device.id, confirm, body.employee_id, now);
    if (refused) {
      await recordAttempt(db, subject, false, "confirm_details", now);
      return refused;
    }
  } else {
    const refused = pinErrorResponse(await verifyPin(db, device.id, body.it_pin!, "update_details"));
    if (refused) return refused;
  }

  const fields = { fullName: body.full_name, email: body.email, department: body.department, position: body.position, phone: body.phone };

  let stored;
  try {
    stored = await db.transaction(async (tx) => {
      // Close the open "confirm details" request. With an approval code this is what makes it single-use:
      // a second save with the same code finds nothing to close and is refused.
      const closed = await tx
        .update(deviceRequests)
        .set({ status: "done", completedAt: now })
        .where(
          and(
            eq(deviceRequests.deviceId, device.id),
            eq(deviceRequests.type, "prompt_details_update"),
            inArray(deviceRequests.status, ["pending", "delivered"]),
            ...(confirm ? [eq(deviceRequests.id, confirm.request_id)] : []),
          ),
        )
        .returning({ id: deviceRequests.id });
      if (confirm && closed.length === 0) throw new Refused(errorResponse(403, "approval_invalid", APPROVAL_INVALID));

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
        // checkConfirm made sure the employee ID is unchanged; the PIN path may reassign.
        if (confirm) throw new Refused(errorResponse(403, "pin_required", EMPLOYEE_ID_NEEDS_PIN));
        if (open) {
          await tx.update(assignments).set({ endAt: now, updatedAt: now }).where(eq(assignments.id, open.id));
        }
        await tx.insert(assignments).values({ deviceId: device.id, userId: user.id, startAt: now, assignedBy: SELF_SERVICE });
      }
      return user;
    });
  } catch (e) {
    if (!(e instanceof Refused)) throw e;
    await recordAttempt(db, subject, false, "confirm_details", now);
    return e.response;
  }
  if (confirm) await recordAttempt(db, subject, true, "confirm_details", now);

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
