import { getDb } from "@/db";
import { handleCancelMove, handleMoveStatus, handleStartMove } from "@/lib/dashboard-server-move";

export const dynamic = "force-dynamic";

export function GET(): Promise<Response> {
  return handleMoveStatus(getDb());
}

export function POST(req: Request): Promise<Response> {
  return handleStartMove(req, getDb());
}

export function DELETE(): Promise<Response> {
  return handleCancelMove(getDb());
}
