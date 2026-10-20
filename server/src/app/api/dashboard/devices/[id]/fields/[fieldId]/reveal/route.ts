import { getDb } from "@/db";
import { handleRevealSecret } from "@/lib/dashboard-fields";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string; fieldId: string }> }): Promise<Response> {
  const { id, fieldId } = await ctx.params;
  return handleRevealSecret(req, getDb(), id, fieldId);
}
