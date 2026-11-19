"use client";

import { useEffect, useRef, useState } from "react";

const REVEAL_SECONDS = 30;

// "Show key": asks for the current IT PIN, shows the key for REVEAL_SECONDS with Copy, then forgets it.
// The key is never kept in the page otherwise; the server logs every attempt.
export function RecoveryKeyReveal({ url, label }: { url: string; label: string }) {
  const [open, setOpen] = useState(false);
  const [pin, setPin] = useState("");
  const [shown, setShown] = useState<{ version: number; key: string } | null>(null);
  const [left, setLeft] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopTimer = () => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
  };
  useEffect(() => stopTimer, []);

  function hide() {
    stopTimer();
    setShown(null);
    setLeft(0);
  }

  async function reveal() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pin }), cache: "no-store" });
      const body = (await res.json().catch(() => ({}))) as { version?: number; key?: string; message?: string };
      if (!res.ok || !body.key || !body.version) throw new Error(body.message ?? `The key could not be shown (HTTP ${res.status})`);
      setPin("");
      setOpen(false);
      setShown({ version: body.version, key: body.key });
      setLeft(REVEAL_SECONDS);
      stopTimer();
      timer.current = setInterval(() => {
        setLeft((n) => {
          if (n <= 1) {
            stopTimer();
            setShown(null);
            return 0;
          }
          return n - 1;
        });
      }, 1000);
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : "The request failed" });
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(shown?.key ?? "");
      setMessage({ ok: true, text: "Copied." });
    } catch {
      setMessage({ ok: false, text: "The browser did not allow copying." });
    }
  }

  return (
    <div className="edit">
      {shown ? (
        <div className="row">
          <span className="mono" style={{ fontSize: "1.1em", color: "var(--fg)" }}>
            {shown.key}
          </span>
          <span className="sub">
            v{shown.version} · hides in {left} s
          </span>
          <button type="button" className="btn" onClick={() => void copy()}>
            Copy
          </button>
          <button type="button" className="btn" onClick={hide}>
            Hide
          </button>
        </div>
      ) : open ? (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            void reveal();
          }}
        >
          <label>
            Current IT PIN
            <input value={pin} onChange={(e) => setPin(e.target.value)} inputMode="numeric" autoComplete="off" maxLength={32} autoFocus />
          </label>
          <button type="submit" className="btn" disabled={busy || !pin.trim()}>
            Show
          </button>
          <button type="button" className="btn" onClick={() => setOpen(false)}>
            Cancel
          </button>
        </form>
      ) : (
        <div className="row">
          <button type="button" className="btn" onClick={() => setOpen(true)}>
            {label}
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
