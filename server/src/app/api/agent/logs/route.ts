import { getDb } from "@/db";
import { handleLogs } from "@/lib/agent/logs";

export const dynamic = "force-dynamic";

export function POST(req: Request): Promise<Response> {
  return handleLogs(req, getDb());
}
