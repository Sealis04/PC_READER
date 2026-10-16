import { getDb } from "@/db";
import { handleScan } from "@/lib/agent/scans";

export const dynamic = "force-dynamic";

export function POST(req: Request): Promise<Response> {
  return handleScan(req, getDb());
}
