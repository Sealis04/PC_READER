import { formatErrors, validateEventsRequest, type EventsMessage } from "@pcreader/contracts";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "@/db";
import { deviceRequests, devices } from "@/db/schema";
import { authenticateDevice } from "@/lib/agent/auth";
import { errorResponse } from "@/lib/http";
import { registerConnection, subscribe } from "@/lib/notifier";

export const HEARTBEAT_SECONDS = 25;

const encoder = new TextEncoder();

function frame(message: EventsMessage): Uint8Array {
  return encoder.encode(`event: ${message.event}\ndata: ${JSON.stringify(message.data)}\n\n`);
}

// Clears the online flag left behind by a previous server process (streams do not survive a restart).
export async function resetOnlineFlags(db: Db): Promise<void> {
  await db.update(devices).set({ online: false, connectionId: null }).where(eq(devices.online, true));
}

// GET /api/agent/events — the device's long-lived Server-Sent Events stream. Open means Online.
// On open every pending request is sent (and delivered ones again, in case the agent died before
// finishing), then new requests the moment they are queued. A heartbeat comment keeps proxies
// from closing an idle stream.
export async function handleEvents(req: Request, db: Db): Promise<Response> {
  const device = await authenticateDevice(req, db);
  if (!device) return errorResponse(401, "unauthorized", "Missing, invalid or revoked device token");

  const query = { agent_version: new URL(req.url).searchParams.get("agent_version") ?? undefined };
  if (!validateEventsRequest(query)) {
    return errorResponse(400, "invalid_payload", "Query does not match events.request schema", formatErrors(validateEventsRequest.errors));
  }

  const connectionId = crypto.randomUUID();
  let cleanup: () => Promise<void> = async () => {};

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const timers: { heartbeat?: ReturnType<typeof setInterval> } = {};
      let unsubscribe = () => {};
      let forget = () => {};
      let chain: Promise<void> = Promise.resolve();

      const send = (chunk: Uint8Array) => {
        if (!closed) controller.enqueue(chunk);
      };

      cleanup = async () => {
        if (closed) return;
        closed = true;
        clearInterval(timers.heartbeat);
        unsubscribe();
        forget();
        try {
          controller.close();
        } catch {
          // already closed by the client
        }
        const now = new Date();
        // Only the stream that is still the device's current one flips it offline.
        await db
          .update(devices)
          .set({ online: false, connectionId: null, lastSeenAt: now })
          .where(and(eq(devices.id, device.id), eq(devices.connectionId, connectionId)));
      };

      // Sends the requests the agent has not been given yet (and, on connect, delivered ones again).
      const flush = (includeDelivered: boolean) => {
        chain = chain.then(async () => {
          if (closed) return;
          const statuses = includeDelivered ? (["pending", "delivered"] as const) : (["pending"] as const);
          const rows = await db
            .select()
            .from(deviceRequests)
            .where(and(eq(deviceRequests.deviceId, device.id), inArray(deviceRequests.status, [...statuses])))
            .orderBy(asc(deviceRequests.createdAt));
          // Mark delivered first: a request sent but still "pending" would be sent again by the
          // next notification, while one marked but lost is re-sent on reconnect.
          const pendingIds = rows.filter((r) => r.status === "pending").map((r) => r.id);
          if (pendingIds.length > 0) {
            await db
              .update(deviceRequests)
              .set({ status: "delivered", deliveredAt: new Date() })
              .where(and(inArray(deviceRequests.id, pendingIds), eq(deviceRequests.status, "pending")));
          }
          for (const r of rows) {
            send(frame({ event: "request", data: { id: r.id, type: r.type, created_at: r.createdAt.toISOString() } }));
          }
        }).catch(() => {
          // a failed read is retried by the next notification or reconnect
        });
        return chain;
      };

      // Subscribe before reading so a request queued meanwhile is not missed.
      unsubscribe = subscribe(device.id, () => void flush(false));
      forget = registerConnection(device.id, { id: connectionId, close: () => void cleanup() });
      const now = new Date();
      await db
        .update(devices)
        .set({ online: true, connectionId, connectedAt: now, lastSeenAt: now, agentVersion: query.agent_version })
        .where(eq(devices.id, device.id));
      send(frame({ event: "hello", data: { heartbeat_seconds: HEARTBEAT_SECONDS } }));
      await flush(true);
      timers.heartbeat = setInterval(() => send(encoder.encode(": heartbeat\n\n")), HEARTBEAT_SECONDS * 1000);
      req.signal.addEventListener("abort", () => void cleanup());
      if (req.signal.aborted) await cleanup();
    },
    cancel() {
      return cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
