// Staff login settings read from the environment. No imports, so proxy.ts can use it cheaply.
type Env = Record<string, string | undefined>;
const REQUIRED = ["BETTER_AUTH_SECRET", "BETTER_AUTH_URL", "HRIS_URL", "HRIS_CLIENT_ID", "HRIS_CLIENT_SECRET"] as const;

export const DEFAULT_ALLOWED_LEVELS = "IT";
export const SESSION_SECONDS = 8 * 60 * 60;

// False when any login setting is missing: the dashboard then fails closed (503 / "Login is not configured").
export function authConfigured(env: Env = process.env): boolean {
  return REQUIRED.every((k) => Boolean(env[k]?.trim()));
}

export function allowedLevels(env: Env = process.env): string[] {
  const list = env.HRIS_ALLOWED_USER_LEVELS?.trim() ? env.HRIS_ALLOWED_USER_LEVELS : DEFAULT_ALLOWED_LEVELS;
  return list.split(",").map((l) => l.trim()).filter(Boolean);
}

// HRIS user levels are compared as written (trimmed, case-sensitive), like HRIS itself does.
export function isAllowedLevel(level: unknown, list: string = allowedLevels().join(",")): boolean {
  if (typeof level !== "string") return false;
  const wanted = level.trim();
  return wanted !== "" && list.split(",").map((l) => l.trim()).includes(wanted);
}

// A same-origin path to return to after login; anything else (//evil.com, https://…, backslashes) becomes /devices.
export function safeNext(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u001f]/.test(value)) return "/devices";
  return value;
}
