import { formatErrors, validateNetworkRequest } from "@pcreader/contracts";
import type { Db } from "@/db";
import { networkLogs } from "@/db/schema";
import { authenticateDevice } from "@/lib/agent/auth";
import { HttpError, errorResponse, readJson } from "@/lib/http";

// POST /api/agent/network — a network snapshot (on connect and when the PC's network changes).
export async function handleNetwork(req: Request, db: Db): Promise<Response> {
  const device = await authenticateDevice(req, db);
  if (!device) return errorResponse(401, "unauthorized", "Missing, invalid or revoked device token");

  let body: unknown;
  try {
    body = await readJson(req);
  } catch (e) {
    if (e instanceof HttpError) return e.response;
    throw e;
  }
  if (!validateNetworkRequest(body)) {
    return errorResponse(400, "invalid_payload", "Request does not match network.request schema", formatErrors(validateNetworkRequest.errors));
  }

  await db.insert(networkLogs).values({
    deviceId: device.id,
    collectedAt: new Date(body.collected_at),
    ipAddresses: body.ip_addresses,
    macAddresses: body.mac_addresses,
    gateway: body.gateway,
    dnsServers: body.dns_servers,
    connectionType: body.connection_type,
    ssid: body.ssid,
    online: true,
  });
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}
