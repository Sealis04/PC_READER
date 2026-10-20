import { getDb } from "@/db";
import { handleSettingsUnlock } from "@/lib/agent/settings-unlock";

export const dynamic = "force-dynamic";

export function POST(req: Request): Promise<Response> {
  return handleSettingsUnlock(req, getDb());
}
