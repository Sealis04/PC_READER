"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

export interface FieldRow {
  id: string;
  name: string;
  type: "text" | "date" | "secret";
  value: string | null;
  hasSecret: boolean;
}

const REVEAL_SECONDS = 30;

async function errorText(res: Response): Promise<string> {
  const b = (await res.json().catch(() => ({}))) as { message?: string };
  return b.message ?? `The change was not accepted (HTTP ${res.status})`;
}

function ValueRow({ deviceId, row }: { deviceId: string; row: FieldRow }) {
  const router = useRouter();
  const [value, setValue] = useState(row.value ?? "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function save() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/dashboard/devices/${deviceId}/fields/${row.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: value.trim() || null }),
        cache: "no-store",
      });
      if (!res.ok) throw new Error(await errorText(res));
      setMessage({ ok: true, text: "Saved." });
      router.refresh();
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : "The change could not be saved" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="row">
      <label>
        {row.name}
        <input type={row.type === "date" ? "date" : "text"} value={value} onChange={(e) => setValue(e.target.value)} maxLength={500} />
      </label>
      <button type="button" className="btn" disabled={busy || value.trim() === (row.value ?? "")} onClick={() => void save()}>
        Save
      </button>
      {message && (
        <span role={message.ok ? "status" : "alert"} className={message.ok ? "sub" : "error"}>
          {message.text}
        </span>
      )}
    </div>
  );
}

type Mode = "idle" | "reveal" | "edit";

// A secret is "••••••" until revealed with the current IT PIN; the value disappears again after
// REVEAL_SECONDS and is never kept in the page otherwise.
function SecretRow({ deviceId, row }: { deviceId: string; row: FieldRow }) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("idle");
  const [pin, setPin] = useState("");
  const [newValue, setNewValue] = useState("");
  const [shown, setShown] = useState<string | null>(null);
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

  async function call(path: string, method: string, body: unknown): Promise<Response | null> {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/dashboard/devices/${deviceId}/fields/${row.id}/${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body), cache: "no-store" });
      if (!res.ok) throw new Error(await errorText(res));
      return res;
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : "The request failed" });
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function reveal() {
    const res = await call("reveal", "POST", { pin });
    if (!res) return;
    const { value } = (await res.json()) as { value: string };
    setPin("");
    setMode("idle");
    setShown(value);
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
    router.refresh();
  }

  async function save(clear: boolean) {
    const res = await call("secret", "PUT", { value: clear ? null : newValue, pin });
    if (!res) return;
    hide();
    setPin("");
    setNewValue("");
    setMode("idle");
    setMessage({ ok: true, text: clear ? "Secret cleared." : "Secret saved." });
    router.refresh();
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(shown ?? "");
      setMessage({ ok: true, text: "Copied." });
    } catch {
      setMessage({ ok: false, text: "The browser did not allow copying." });
    }
  }

  return (
    <div className="edit">
      <div className="row">
        <label>
          {row.name} (secret)
          <span className="mono" style={{ minWidth: 180, display: "inline-block", padding: "4px 0", color: "var(--fg)" }}>
            {shown !== null ? shown : row.hasSecret ? "••••••" : "Not set"}
          </span>
        </label>
        {shown !== null ? (
          <>
            <span className="sub">Hides in {left} s</span>
            <button type="button" className="btn" onClick={() => void copy()}>
              Copy
            </button>
            <button type="button" className="btn" onClick={hide}>
              Hide
            </button>
          </>
        ) : (
          <>
            {row.hasSecret && (
              <button type="button" className="btn" disabled={busy} onClick={() => setMode(mode === "reveal" ? "idle" : "reveal")}>
                Reveal
              </button>
            )}
            <button type="button" className="btn" disabled={busy} onClick={() => setMode(mode === "edit" ? "idle" : "edit")}>
              {row.hasSecret ? "Change" : "Set"}
            </button>
          </>
        )}
      </div>
      {mode !== "idle" && (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            void (mode === "reveal" ? reveal() : save(false));
          }}
        >
          {mode === "edit" && (
            <label>
              New value
              <input type="password" autoComplete="new-password" value={newValue} onChange={(e) => setNewValue(e.target.value)} maxLength={1000} />
            </label>
          )}
          <label>
            Current IT PIN
            <input value={pin} onChange={(e) => setPin(e.target.value)} inputMode="numeric" autoComplete="off" maxLength={32} />
          </label>
          <button type="submit" className="btn" disabled={busy || !pin.trim() || (mode === "edit" && !newValue)}>
            {mode === "reveal" ? "Reveal" : "Save secret"}
          </button>
          {mode === "edit" && row.hasSecret && (
            <button type="button" className="btn" disabled={busy || !pin.trim()} onClick={() => void save(true)}>
              Clear secret
            </button>
          )}
        </form>
      )}
      {message && (
        <p role={message.ok ? "status" : "alert"} className={message.ok ? "sub" : "error"}>
          {message.text}
        </p>
      )}
    </div>
  );
}

export function CustomFieldsPanel({ deviceId, rows, secretsReason }: { deviceId: string; rows: FieldRow[]; secretsReason: string | null }) {
  if (rows.length === 0) return <p className="sub">No custom fields yet. Add them on the Fields page.</p>;
  return (
    <div className="edit">
      {rows.map((r) =>
        r.type !== "secret" ? (
          <ValueRow key={r.id} deviceId={deviceId} row={r} />
        ) : secretsReason ? (
          <p key={r.id} className="sub">
            {r.name} (secret): disabled — {secretsReason}.
          </p>
        ) : (
          <SecretRow key={r.id} deviceId={deviceId} row={r} />
        ),
      )}
    </div>
  );
}
