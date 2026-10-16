import { getDb } from "@/db";
import { handleRegister } from "@/lib/agent/register";

export const dynamic = "force-dynamic";

export function POST(req: Request): Promise<Response> {
  return handleRegister(req, getDb());
}
