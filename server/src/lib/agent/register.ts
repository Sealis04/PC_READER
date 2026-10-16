import { formatErrors, validateRegisterRequest, type RegisterResponse } from "@pcreader/contracts";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@/db";
import { assignments, devices, users } from "@/db/schema";
import { HttpError, errorResponse, jsonResponse, readJson } from "@/lib/http";
import { generateDeviceToken, hashToken, secretsMatch } from "@/lib/tokens";

export const SELF_REGISTRATION = "self-registration";

export function checkinIntervalSeconds(): number {
  const value = Number(process.env.CHECKIN_INTERVAL_SECONDS);
  return Number.isInteger(value) && value >= 60 ? value : 300;
}

// POST /api/agent/register — first-time (or repeat) registration from the agent.
// A repeat registration of the same device_uuid issues a new token and invalidates the old one.
export async function handleRegister(req: Request, db: Db): Promise<Response> {
  let body: unknown;
  try {
    body = await readJson(req);
  } catch (e) {
    if (e instanceof HttpError) return e.response;
    throw e;
  }

  if (!validateRegisterRequest(body)) {
    return errorResponse(400, "invalid_payload", "Request does not match register.request schema", formatErrors(validateRegisterRequest.errors));
  }

  const expectedKey = process.env.ENROLLMENT_KEY;
  if (!expectedKey) {
    return errorResponse(503, "enrollment_disabled", "Server has no ENROLLMENT_KEY configured");
  }
  if (!secretsMatch(body.enrollment_key, expectedKey)) {
    return errorResponse(403, "invalid_enrollment_key", "Enrollment key is not valid");
  }

  const token = generateDeviceToken();
  const now = new Date();
  const { user: u, hardware_summary: hw } = body;

  const deviceId = await db.transaction(async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({
        fullName: u.full_name,
        employeeId: u.employee_id,
        email: u.email,
        department: u.department,
        position: u.position,
        phone: u.phone,
        policyAcknowledgedAt: now,
      })
      .onConflictDoUpdate({
        target: users.employeeId,
        set: {
          fullName: u.full_name,
          email: u.email,
          department: u.department,
          position: u.position,
          phone: u.phone,
          policyAcknowledgedAt: now,
          updatedAt: now,
        },
      })
      .returning({ id: users.id });

    const deviceFields = {
      hostname: body.hostname,
      osType: body.os_type,
      manufacturer: hw.manufacturer,
      model: hw.model,
      serialNumber: hw.serial_number,
      tokenHash: hashToken(token),
      lastSeenAt: now,
    };
    const [device] = await tx
      .insert(devices)
      .values({ deviceUuid: body.device_uuid, ...deviceFields })
      .onConflictDoUpdate({ target: devices.deviceUuid, set: { ...deviceFields, updatedAt: now } })
      .returning({ id: devices.id });

    // One open assignment per device: keep it if the same user re-registers, otherwise hand over.
    const [open] = await tx
      .select({ id: assignments.id, userId: assignments.userId })
      .from(assignments)
      .where(and(eq(assignments.deviceId, device.id), isNull(assignments.endAt)))
      .for("update");
    if (!open || open.userId !== user.id) {
      if (open) {
        await tx.update(assignments).set({ endAt: now, updatedAt: now }).where(eq(assignments.id, open.id));
      }
      await tx.insert(assignments).values({ deviceId: device.id, userId: user.id, startAt: now, assignedBy: SELF_REGISTRATION });
    }

    return device.id;
  });

  const response: RegisterResponse = {
    device_id: deviceId,
    device_token: token,
    checkin_interval_seconds: checkinIntervalSeconds(),
  };
  return jsonResponse(response, 201);
}
