import { getDb } from "@/db";
import { handleUserUpdate } from "@/lib/agent/user";

export const dynamic = "force-dynamic";

export function PUT(req: Request): Promise<Response> {
  return handleUserUpdate(req, getDb());
}
