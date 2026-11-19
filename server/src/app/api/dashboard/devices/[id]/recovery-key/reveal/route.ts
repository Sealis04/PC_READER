import { getDb } from "@/db";
import { handleRevealDeviceRecoveryKey } from "@/lib/dashboard-recovery-key";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  return handleRevealDeviceRecoveryKey(req, getDb(), id);
}
