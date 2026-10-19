import { getDb } from "@/db";
import { handleRequestComplete } from "@/lib/agent/complete";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  return handleRequestComplete(req, getDb(), id);
}
