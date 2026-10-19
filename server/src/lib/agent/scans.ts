import { formatErrors, validateScansRequest, type ScansResponse } from "@pcreader/contracts";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { devices, scans } from "@/db/schema";
import { authenticateDevice } from "@/lib/agent/auth";
import { deriveComponents, syncComponents } from "@/lib/components";
import { HttpError, errorResponse, jsonResponse, readJson } from "@/lib/http";

// POST /api/agent/scans — stores a full scan and syncs the device's components.
export async function handleScan(req: Request, db: Db): Promise<Response> {
  const device = await authenticateDevice(req, db);
  if (!device) {
    return errorResponse(401, "unauthorized", "Missing, invalid or revoked device token");
  }

  let body: unknown;
  try {
    body = await readJson(req);
  } catch (e) {
    if (e instanceof HttpError) return e.response;
    throw e;
  }

  if (!validateScansRequest(body)) {
    return errorResponse(400, "invalid_payload", "Request does not match scans.request schema", formatErrors(validateScansRequest.errors));
  }
  if (body.payload.os_type !== device.osType) {
    return errorResponse(400, "invalid_payload", `Payload os_type ${body.payload.os_type} does not match registered ${device.osType}`);
  }

  const now = new Date();
  const collectedAt = new Date(body.collected_at);
  const payload = body.payload;

  const result = await db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(scans)
      .values({
        deviceId: device.id,
        scanUuid: body.scan_uuid,
        scanType: body.scan_type,
        collectedAt,
        receivedAt: now,
        payload,
        schemaVersion: payload.schema_version,
      })
      .onConflictDoNothing({ target: scans.scanUuid })
      .returning({ id: scans.id });

    if (!inserted) {
      const [existing] = await tx.select({ id: scans.id }).from(scans).where(eq(scans.scanUuid, body.scan_uuid));
      return { duplicate: true as const, scanId: existing.id };
    }

    // Lock the device row so concurrent scans for one device apply in order.
    const [current] = await tx
      .select({ lastFullScanAt: devices.lastFullScanAt })
      .from(devices)
      .where(eq(devices.id, device.id))
      .for("update");

    // A late retry of an older scan is stored but must not roll components back.
    const isLatest = !current.lastFullScanAt || collectedAt >= current.lastFullScanAt;
    if (isLatest) {
      await syncComponents(tx, device.id, deriveComponents(payload), now);
    }

    await tx
      .update(devices)
      .set({
        lastSeenAt: now,
        updatedAt: now,
        ...(isLatest && {
          lastFullScanAt: collectedAt,
          hostname: payload.system.hostname,
          manufacturer: payload.system.manufacturer,
          model: payload.system.model,
          serialNumber: payload.system.serial_number,
        }),
      })
      .where(eq(devices.id, device.id));

    return { duplicate: false as const, scanId: inserted.id };
  });

  const response: ScansResponse = { scan_id: result.scanId };
  return jsonResponse(response, result.duplicate ? 409 : 201);
}
