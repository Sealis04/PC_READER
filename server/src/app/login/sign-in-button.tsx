"use client";

import { useState } from "react";

export function SignInButton({ next }: { next: string }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function signIn() {
    setBusy(true);
    setFailed(false);
    try {
      const res = await fetch("/api/auth/sign-in/oauth2", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ providerId: "hris", callbackURL: next, errorCallbackURL: "/login" }),
      });
      const body = (await res.json()) as { url?: string };
      if (!res.ok || !body.url) throw new Error("sign-in failed");
      window.location.assign(body.url);
    } catch {
      setFailed(true);
      setBusy(false);
    }
  }

  return (
    <>
      <button type="button" onClick={signIn} disabled={busy}>
        {busy ? "Redirecting to HRIS…" : "Sign in with HRIS"}
      </button>
      {failed && <p role="alert" className="sub">Could not reach HRIS. Try again.</p>}
    </>
  );
}
