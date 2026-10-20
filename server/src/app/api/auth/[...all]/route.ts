import { getAuth, handleAuthRequest } from "@/lib/auth";
import { errorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

// Better Auth's endpoints (HRIS sign-in, callback, sign-out). 503 while the login settings are missing.
async function handle(req: Request): Promise<Response> {
  const auth = getAuth();
  if (!auth) return errorResponse(503, "not_configured", "Login is not configured");
  return handleAuthRequest(auth, req);
}

export const GET = handle;
export const POST = handle;
