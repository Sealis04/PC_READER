import { getDb } from "@/db";
import { handleInventoryAction } from "@/lib/dashboard-inventory";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  return handleInventoryAction(req, getDb(), id);
}
