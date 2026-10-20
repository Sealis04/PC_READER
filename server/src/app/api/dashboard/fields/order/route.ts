import { getDb } from "@/db";
import { requireStaffApi } from "@/lib/staff-auth";
import { handleReorderFields } from "@/lib/dashboard-fields";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const staff = await requireStaffApi(req);
  if (staff instanceof Response) return staff;
  return handleReorderFields(req, getDb());
}
