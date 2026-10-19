"use client";

import { useEffect, useState } from "react";

interface State {
  pin: string;
  expiresAt: string;
}

function remaining(expiresAt: string, now: number): string {
  const s = Math.max(0, Math.round((new Date(expiresAt).getTime() - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// The current PIN with a live countdown. When the hour runs out it fetches the new PIN itself.
export function PinBox({ initialPin, initialExpiresAt, timeZone }: { initialPin: string; initialExpiresAt: string; timeZone: string }) {
  const [state, setState] = useState<State>({ pin: initialPin, expiresAt: initialExpiresAt });
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function call(method: "GET" | "POST") {
    setError(null);
    try {
      const res = await fetch("/api/dashboard/it-pin", { method, cache: "no-store" });
      if (!res.ok) throw new Error(`The server answered HTTP ${res.status}`);
      const body = (await res.json()) as { pin: string; expires_at: string };
      setState({ pin: body.pin, expiresAt: body.expires_at });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not reach the server");
    }
  }

  const expired = new Date(state.expiresAt).getTime() <= now;
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (expired) void call("GET");
  }, [expired]);

  const changesAt = new Intl.DateTimeFormat("en-PH", { timeZone, hour: "numeric", minute: "2-digit" }).format(new Date(state.expiresAt));

  return (
    <div>
      <p className="mono" style={{ fontSize: 48, letterSpacing: "0.15em", margin: "8px 0" }} aria-label="Current IT PIN">
        {state.pin}
      </p>
      <p className="sub">
        Changes at {changesAt} (in <span className="num">{remaining(state.expiresAt, now)}</span>)
      </p>
      <button
        type="button"
        className="btn"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          await call("POST");
          setBusy(false);
        }}
      >
        Change now
      </button>
      {error && (
        <p role="alert" className="sub">
          {error}
        </p>
      )}
    </div>
  );
}
