"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

// "Server address": the new URL and the current IT PIN start a move; "Cancel move" stops telling PCs.
export function ServerMoveForm({ active }: { active: boolean }) {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function call(init: RequestInit, done: string) {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/dashboard/server-move", { ...init, cache: "no-store" });
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      if (!res.ok) throw new Error(body.message ?? `The request was not accepted (HTTP ${res.status})`);
      setUrl("");
      setPin("");
      setMessage({ ok: true, text: done });
      router.refresh();
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : "The request failed" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="edit">
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          void call(
            { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url, pin }) },
            "Move started. Connected PCs check the new address now; the others when they connect.",
          );
        }}
      >
        <label>
          New server address
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://pcreader.office.local:3000" style={{ minWidth: 300 }} maxLength={2048} />
        </label>
        <label>
          Current IT PIN
          <input value={pin} onChange={(e) => setPin(e.target.value)} inputMode="numeric" autoComplete="off" maxLength={32} />
        </label>
        <button type="submit" className="btn" disabled={busy || !url.trim() || !pin.trim()}>
          {active ? "Start a new move" : "Move PCs to this address"}
        </button>
        {active && (
          <button type="button" className="btn" disabled={busy} onClick={() => void call({ method: "DELETE" }, "Move cancelled. PCs that already moved stay on the new address.")}>
            Cancel move
          </button>
        )}
      </form>
      {message && (
        <p role={message.ok ? "status" : "alert"} className={message.ok ? "sub" : "error"}>
          {message.text}
        </p>
      )}
    </div>
  );
}
