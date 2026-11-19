import { getDb } from "@/db";
import { handleRecoveryKeyAck } from "@/lib/agent/recovery-key-ack";

export const dynamic = "force-dynamic";

export function POST(req: Request): Promise<Response> {
  return handleRecoveryKeyAck(req, getDb());
}
