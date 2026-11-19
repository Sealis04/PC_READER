import { getDb } from "@/db";
import { handleMe } from "@/lib/agent/server-move";

export const dynamic = "force-dynamic";

export function GET(req: Request): Promise<Response> {
  return handleMe(req, getDb());
}
