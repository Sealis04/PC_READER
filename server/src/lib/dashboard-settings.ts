import type { Db } from "@/db";
import { clientIp } from "@/lib/it-pin";
import { recordStaffEvent } from "@/lib/staff-events";
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

// POST /api/dashboard/settings { agency_name?, inventory_prefix? } — logged as a settings_changed staff event.
export async function handleUpdateSettings(req: Request, db: Db, staffId: string | null = null): Promise<Response> {
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
    const settings = await updateSettings(db, { agencyName: b.agency_name, inventoryPrefix: b.inventory_prefix });
    const fields = [b.agency_name !== undefined && "agency name", b.inventory_prefix !== undefined && "inventory prefix"].filter(Boolean).join(", ");
    await recordStaffEvent(db, { type: "settings_changed", staffUserId: staffId, detail: `Changed ${fields}`, clientIp: clientIp(req) });
    return jsonResponse(body(settings));
  } catch (e) {
    return fail(e);
  }
}

// POST /api/dashboard/settings/logo — the raw image as the request body (Content-Type image/png, image/jpeg
// or image/webp, at most 512 KB). Replaces the current logo.
export async function handleSetLogo(req: Request, db: Db, staffId: string | null = null): Promise<Response> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_LOGO_BYTES) return errorResponse(413, "payload_too_large", `The logo must be at most ${MAX_LOGO_BYTES / 1024} KB`);
  const bytes = new Uint8Array(await req.arrayBuffer());
  try {
    const settings = await setLogo(db, bytes, req.headers.get("content-type") ?? "");
    await recordStaffEvent(db, { type: "logo_changed", staffUserId: staffId, detail: "Logo replaced", clientIp: clientIp(req) });
    return jsonResponse(body(settings));
  } catch (e) {
    return fail(e);
  }
}

// DELETE /api/dashboard/settings/logo
export async function handleClearLogo(req: Request, db: Db, staffId: string | null = null): Promise<Response> {
  const settings = await clearLogo(db);
  await recordStaffEvent(db, { type: "logo_changed", staffUserId: staffId, detail: "Logo removed", clientIp: clientIp(req) });
  return jsonResponse(body(settings));
}
