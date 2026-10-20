import { getDb } from "@/db";
import { handleClearLogo, handleSetLogo } from "@/lib/dashboard-settings";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  return handleSetLogo(req, getDb());
}

export async function DELETE(): Promise<Response> {
  return handleClearLogo(getDb());
}
