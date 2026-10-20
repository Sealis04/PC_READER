import { getDb } from "@/db";
import { handleGetSettings, handleUpdateSettings } from "@/lib/dashboard-settings";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return handleGetSettings(getDb());
}

export async function POST(req: Request): Promise<Response> {
  return handleUpdateSettings(req, getDb());
}
