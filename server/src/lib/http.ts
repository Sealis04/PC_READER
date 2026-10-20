import type { ValidationIssue } from "@pcreader/contracts";

export const MAX_BODY_BYTES = 2 * 1024 * 1024;

export type ErrorCode =
  | "invalid_json"
  | "invalid_payload"
  | "unauthorized"
  | "not_configured"
  | "invalid_enrollment_key"
  | "enrollment_disabled"
  | "wrong_pin"
  | "pin_required"
  | "approval_invalid"
  | "too_many_attempts"
  | "payload_too_large"
  | "unsupported_media_type"
  | "not_found"
  | "conflict";

export function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

export function errorResponse(status: number, error: ErrorCode, message: string, details?: ValidationIssue[]): Response {
  return jsonResponse(details ? { error, message, details } : { error, message }, status);
}

export class HttpError extends Error {
  constructor(public readonly response: Response) {
    super("http error");
  }
}

// Reads and parses a JSON body, enforcing the size limit (413) and JSON syntax (400).
export async function readJson(req: Request): Promise<unknown> {
  const type = req.headers.get("content-type") ?? "";
  if (!type.toLowerCase().startsWith("application/json")) {
    throw new HttpError(errorResponse(415, "unsupported_media_type", "Content-Type must be application/json"));
  }
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) {
    throw new HttpError(errorResponse(413, "payload_too_large", `Body exceeds ${MAX_BODY_BYTES} bytes`));
  }
  const text = await req.text();
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) {
    throw new HttpError(errorResponse(413, "payload_too_large", `Body exceeds ${MAX_BODY_BYTES} bytes`));
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(errorResponse(400, "invalid_json", "Body is not valid JSON"));
  }
}

export function bearerToken(req: Request): string | null {
  const header = req.headers.get("authorization");
  const match = header?.match(/^Bearer\s+(\S+)$/i);
  return match ? match[1] : null;
}
