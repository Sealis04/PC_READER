import { getDb } from "@/db";
import { requireStaffApi } from "@/lib/staff-auth";
import { handleListRequests, handleQueueRequest } from "@/lib/dashboard-requests";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const staff = await requireStaffApi(req);
  if (staff instanceof Response) return staff;
  const { id } = await ctx.params;
  return handleQueueRequest(req, getDb(), id);
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const staff = await requireStaffApi(req);
  if (staff instanceof Response) return staff;
  const { id } = await ctx.params;
  return handleListRequests(getDb(), id);
}
