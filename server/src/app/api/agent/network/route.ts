import { getDb } from "@/db";
import { handleNetwork } from "@/lib/agent/network";

export const dynamic = "force-dynamic";

export function POST(req: Request): Promise<Response> {
  return handleNetwork(req, getDb());
}
