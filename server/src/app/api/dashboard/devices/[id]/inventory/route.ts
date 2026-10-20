import { getDb } from "@/db";
import { requireStaffApi } from "@/lib/staff-auth";
import { handleInventoryAction } from "@/lib/dashboard-inventory";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const staff = await requireStaffApi(req);
  if (staff instanceof Response) return staff;
  const { id } = await ctx.params;
  return handleInventoryAction(req, getDb(), id);
}
