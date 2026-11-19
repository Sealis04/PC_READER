import { getDb } from "@/db";
import { handleRecoveryStatus } from "@/lib/dashboard-recovery-key";

export const dynamic = "force-dynamic";

export function GET(): Promise<Response> {
  return handleRecoveryStatus(getDb());
}
