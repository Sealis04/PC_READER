import { getDb } from "@/db";
import { handleQueueRequest } from "@/lib/dashboard-requests";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  return handleQueueRequest(req, getDb(), id);
}
