import { getDb } from "@/db";
import { handleRevealRecoveryKey } from "@/lib/dashboard-recovery-key";

export const dynamic = "force-dynamic";

export function POST(req: Request): Promise<Response> {
  return handleRevealRecoveryKey(req, getDb());
}
