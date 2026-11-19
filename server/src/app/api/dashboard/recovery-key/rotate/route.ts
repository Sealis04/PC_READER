import { getDb } from "@/db";
import { handleRotateRecoveryKey } from "@/lib/dashboard-recovery-key";

export const dynamic = "force-dynamic";

export function POST(req: Request): Promise<Response> {
  return handleRotateRecoveryKey(req, getDb());
}
