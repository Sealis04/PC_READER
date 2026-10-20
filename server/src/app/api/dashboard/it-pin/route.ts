import { getDb } from "@/db";
import { handleGetPin, handleRotatePin } from "@/lib/dashboard-it-pin";
import { requireStaffApi } from "@/lib/staff-auth";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const staff = await requireStaffApi(req);
  if (staff instanceof Response) return staff;
  return handleGetPin(getDb());
}

export async function POST(req: Request): Promise<Response> {
  const staff = await requireStaffApi(req);
  if (staff instanceof Response) return staff;
  return handleRotatePin(req, getDb(), staff.id);
}
