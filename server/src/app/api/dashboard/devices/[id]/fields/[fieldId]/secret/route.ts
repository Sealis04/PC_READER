import { getDb } from "@/db";
import { handleSetSecret } from "@/lib/dashboard-fields";

export const dynamic = "force-dynamic";

export async function PUT(req: Request, ctx: { params: Promise<{ id: string; fieldId: string }> }): Promise<Response> {
  const { id, fieldId } = await ctx.params;
  return handleSetSecret(req, getDb(), id, fieldId);
}
