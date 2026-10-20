import { getDb } from "@/db";
import { handleBrandingLogo } from "@/lib/branding";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  return handleBrandingLogo(req, getDb());
}
