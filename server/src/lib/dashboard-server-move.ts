import type { Db } from "@/db";
import { HttpError, errorResponse, jsonResponse, readJson } from "@/lib/http";
import { clientIp } from "@/lib/it-pin";
import { cancelMove, MoveError, moveSummary, startMove } from "@/lib/server-move";

// GET /api/dashboard/server-move — the active move and how far the PCs got (null when none).
export async function handleMoveStatus(db: Db): Promise<Response> {
  const s = await moveSummary(db);
  return jsonResponse(
    s && {
      id: s.move.id,
      url: s.move.url,
      created_at: s.move.createdAt.toISOString(),
      moved: s.moved,
      waiting: s.waiting,
      not_moved: s.notMoved.map((n) => ({ device_id: n.deviceId, hostname: n.hostname, reason: n.reason, at: n.at.toISOString() })),
    },
  );
}

// POST /api/dashboard/server-move { url, pin } → 201 { id, url }: tells the PCs to move (IT PIN needed).
export async function handleStartMove(req: Request, db: Db): Promise<Response> {
  let b: Record<string, unknown>;
  try {
    const json = await readJson(req);
    b = json && typeof json === "object" && !Array.isArray(json) ? (json as Record<string, unknown>) : {};
  } catch (e) {
    if (e instanceof HttpError) return e.response;
    throw e;
  }
  try {
    const m = await startMove(db, b.url, b.pin, clientIp(req));
    return jsonResponse({ id: m.id, url: m.url }, 201);
  } catch (e) {
    if (e instanceof MoveError) return errorResponse(e.status, e.code, e.message);
    throw e;
  }
}

// DELETE /api/dashboard/server-move — "Cancel move". PCs that already moved stay moved.
export async function handleCancelMove(db: Db): Promise<Response> {
  return jsonResponse({ cancelled: await cancelMove(db) });
}
