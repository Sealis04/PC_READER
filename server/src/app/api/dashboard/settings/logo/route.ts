import { getDb } from "@/db";
import { requireStaffApi } from "@/lib/staff-auth";
import { handleClearLogo, handleSetLogo } from "@/lib/dashboard-settings";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const staff = await requireStaffApi(req);
  if (staff instanceof Response) return staff;
  return handleSetLogo(req, getDb(), staff.id);
}

export async function DELETE(req: Request): Promise<Response> {
  const staff = await requireStaffApi(req);
  if (staff instanceof Response) return staff;
  return handleClearLogo(req, getDb(), staff.id);
}
