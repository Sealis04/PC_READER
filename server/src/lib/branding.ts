import type { Db } from "@/db";
import { errorResponse, jsonResponse } from "@/lib/http";
import { brandingOf, getLogo, getSettings } from "@/lib/settings";

// GET /api/branding — public (the desktop app needs no token): { name, logo_url }. logo_url is a path on
// this server (or null) with a version, e.g. /api/branding/logo?v=1760000000000.
export async function handleBranding(db: Db): Promise<Response> {
  return jsonResponse(brandingOf(await getSettings(db)));
}

// GET /api/branding/logo — the logo with its content type. A request carrying the current version may be
// cached for good; any other request must revalidate. 404 when no logo is set.
export async function handleBrandingLogo(req: Request, db: Db): Promise<Response> {
  const logo = await getLogo(db);
  if (!logo) return errorResponse(404, "not_found", "No logo is set");
  const current = new URL(req.url).searchParams.get("v") === String(logo.updatedAt.getTime());
  return new Response(new Uint8Array(logo.bytes), {
    headers: {
      "content-type": logo.contentType,
      "cache-control": current ? "public, max-age=31536000, immutable" : "no-cache",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'",
    },
  });
}
