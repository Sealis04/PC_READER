import { getDb } from "@/db";
import { handleCreateField, handleListFields } from "@/lib/dashboard-fields";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  return handleListFields(getDb(), new URL(req.url).searchParams.get("archived") === "1");
}

export async function POST(req: Request): Promise<Response> {
  return handleCreateField(req, getDb());
}
