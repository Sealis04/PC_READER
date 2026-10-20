import { getDb } from "@/db";
import { handleBranding } from "@/lib/branding";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return handleBranding(getDb());
}
