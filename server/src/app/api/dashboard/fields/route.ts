import { getDb } from "@/db";
import { requireStaffApi } from "@/lib/staff-auth";
import { handleCreateField, handleListFields } from "@/lib/dashboard-fields";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const staff = await requireStaffApi(req);
  if (staff instanceof Response) return staff;
  return handleListFields(getDb(), new URL(req.url).searchParams.get("archived") === "1");
}

export async function POST(req: Request): Promise<Response> {
  const staff = await requireStaffApi(req);
  if (staff instanceof Response) return staff;
  return handleCreateField(req, getDb());
}
