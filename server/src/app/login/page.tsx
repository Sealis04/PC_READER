import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { safeBranding } from "@/lib/settings";
import { authConfigured, safeNext } from "@/lib/staff-config";
import { getStaff } from "@/lib/staff-auth";
import { SignInButton } from "./sign-in-button";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Sign in" };

const MESSAGES: Record<string, string> = {
  not_allowed: "Your HRIS account is not allowed to use PC_READER.",
  not_configured: "Login is not configured. Ask the administrator to set the HRIS login settings on this server.",
};
const GENERIC = "Sign-in failed. Try again, or ask IT if it keeps happening.";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string; next?: string }> }) {
  const { error, next } = await searchParams;
  const configured = authConfigured();
  const target = safeNext(next);
  if (!error && (await getStaff())) redirect(target);
  const { name } = await safeBranding(getDb);
  const message = !configured ? MESSAGES.not_configured : error ? (MESSAGES[error] ?? GENERIC) : null;
  return (
    <section className="panel pad" style={{ maxWidth: 420, margin: "48px auto" }}>
      <h1>{name}</h1>
      <p className="sub">Sign in with your HRIS account to use the staff dashboard.</p>
      {message && <p role="alert" className="pill warn">{message}</p>}
      {configured && <SignInButton next={target} />}
    </section>
  );
}
