import { getDb } from "@/db";
import { requireStaffApi } from "@/lib/staff-auth";
import { handleGetSettings, handleUpdateSettings } from "@/lib/dashboard-settings";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const staff = await requireStaffApi(req);
  if (staff instanceof Response) return staff;
  return handleGetSettings(getDb());
}

export async function POST(req: Request): Promise<Response> {
  const staff = await requireStaffApi(req);
  if (staff instanceof Response) return staff;
  return handleUpdateSettings(req, getDb());
}
