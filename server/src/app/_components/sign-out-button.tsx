"use client";

import { useState } from "react";

export function SignOutButton() {
  const [busy, setBusy] = useState(false);

  async function signOut() {
    setBusy(true);
    try {
      await fetch("/api/auth/sign-out", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    } finally {
      window.location.assign("/login");
    }
  }

  return (
    <button type="button" className="link" onClick={signOut} disabled={busy}>
      Sign out
    </button>
  );
}
