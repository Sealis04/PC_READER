"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

// "New key now": asks for the current IT PIN. PCs that are connected receive the new key's hash at once.
export function RotateRecoveryKey() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function rotate() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/dashboard/recovery-key/rotate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pin }), cache: "no-store" });
      const body = (await res.json().catch(() => ({}))) as { version?: number; message?: string };
      if (!res.ok) throw new Error(body.message ?? `No new key was made (HTTP ${res.status})`);
      setPin("");
      setOpen(false);
      setMessage({ ok: true, text: `Version ${body.version} is now the recovery key. Connected PCs receive it now, the others when they connect.` });
      router.refresh();
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : "The request failed" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="edit">
      {open ? (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            void rotate();
          }}
        >
          <label>
            Current IT PIN
            <input value={pin} onChange={(e) => setPin(e.target.value)} inputMode="numeric" autoComplete="off" maxLength={32} autoFocus />
          </label>
          <button type="submit" className="btn" disabled={busy || !pin.trim()}>
            Make a new key
          </button>
          <button type="button" className="btn" onClick={() => setOpen(false)}>
            Cancel
          </button>
        </form>
      ) : (
        <div className="row">
          <button type="button" className="btn" onClick={() => setOpen(true)}>
            New key now
          </button>
        </div>
      )}
      {message && (
        <p role={message.ok ? "status" : "alert"} className={message.ok ? "sub" : "error"}>
          {message.text}
        </p>
      )}
    </div>
  );
}
