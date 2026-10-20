import { getDb } from "@/db";
import { requireStaffApi } from "@/lib/staff-auth";
import { handleDeviceFields } from "@/lib/dashboard-fields";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const staff = await requireStaffApi(req);
  if (staff instanceof Response) return staff;
  const { id } = await ctx.params;
  return handleDeviceFields(getDb(), id);
}
