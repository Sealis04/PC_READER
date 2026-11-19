import { getDb } from "@/db";
import { handleMoveResult } from "@/lib/agent/server-move";

export const dynamic = "force-dynamic";

export function POST(req: Request): Promise<Response> {
  return handleMoveResult(req, getDb());
}
