import type { Db } from "@/db";
import { HttpError, errorResponse, jsonResponse, readJson } from "@/lib/http";
import { clearLogo, getSettings, logoUrl, MAX_LOGO_BYTES, setLogo, SettingsError, updateSettings, type Settings } from "@/lib/settings";

const body = (s: Settings) => ({ agency_name: s.agencyName, inventory_prefix: s.inventoryPrefix, logo_url: logoUrl(s) });

function fail(e: unknown): Response {
  if (e instanceof SettingsError) return errorResponse(e.status, e.code, e.message);
  throw e;
}

// GET /api/dashboard/settings — { agency_name, inventory_prefix, logo_url }.
export async function handleGetSettings(db: Db): Promise<Response> {
  return jsonResponse(body(await getSettings(db)));
}

// POST /api/dashboard/settings { agency_name?, inventory_prefix? } — no staff login yet (accepted risk).
export async function handleUpdateSettings(req: Request, db: Db): Promise<Response> {
  let json: unknown;
  try {
    json = await readJson(req);
  } catch (e) {
    if (e instanceof HttpError) return e.response;
    throw e;
  }
  const b = (json && typeof json === "object" && !Array.isArray(json) ? json : {}) as Record<string, unknown>;
  if (b.agency_name === undefined && b.inventory_prefix === undefined) return errorResponse(400, "invalid_payload", "Send agency_name and/or inventory_prefix");
  try {
    return jsonResponse(body(await updateSettings(db, { agencyName: b.agency_name, inventoryPrefix: b.inventory_prefix })));
  } catch (e) {
    return fail(e);
  }
}

// POST /api/dashboard/settings/logo — the raw image as the request body (Content-Type image/png, image/jpeg
// or image/webp, at most 512 KB). Replaces the current logo.
export async function handleSetLogo(req: Request, db: Db): Promise<Response> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_LOGO_BYTES) return errorResponse(413, "payload_too_large", `The logo must be at most ${MAX_LOGO_BYTES / 1024} KB`);
  const bytes = new Uint8Array(await req.arrayBuffer());
  try {
    return jsonResponse(body(await setLogo(db, bytes, req.headers.get("content-type") ?? "")));
  } catch (e) {
    return fail(e);
  }
}

// DELETE /api/dashboard/settings/logo
export async function handleClearLogo(db: Db): Promise<Response> {
  return jsonResponse(body(await clearLogo(db)));
}
