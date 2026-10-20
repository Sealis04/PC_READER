import { getDb } from "@/db";
import { handleReorderFields } from "@/lib/dashboard-fields";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  return handleReorderFields(req, getDb());
}
