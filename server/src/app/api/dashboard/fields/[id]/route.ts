import { getDb } from "@/db";
import { handleUpdateField } from "@/lib/dashboard-fields";

export const dynamic = "force-dynamic";

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  return handleUpdateField(req, getDb(), id);
}
