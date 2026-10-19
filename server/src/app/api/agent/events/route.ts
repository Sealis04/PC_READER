import { getDb } from "@/db";
import { handleEvents } from "@/lib/agent/events";

// Long-lived stream: Node runtime (not edge), never cached.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(req: Request): Promise<Response> {
  return handleEvents(req, getDb());
}
