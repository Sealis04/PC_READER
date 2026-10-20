"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

interface State {
  agencyName: string;
  inventoryPrefix: string;
  logoUrl: string | null;
}

interface Api {
  agency_name: string;
  inventory_prefix: string;
  logo_url: string | null;
  message?: string;
}

const fromApi = (b: Api): State => ({ agencyName: b.agency_name, inventoryPrefix: b.inventory_prefix, logoUrl: b.logo_url });

// Agency name + prefix are saved together; the logo is uploaded or removed on its own.
// The server's message (bad prefix, file too big, ...) is shown inline.
export function SettingsForm({ initial, limits }: { initial: State; limits: { logoKb: number; prefixMin: number; prefixMax: number } }) {
  const router = useRouter();
  const [saved, setSaved] = useState(initial);
  const [name, setName] = useState(initial.agencyName);
  const [prefix, setPrefix] = useState(initial.inventoryPrefix);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function call(what: string, url: string, init: RequestInit, done: string) {
    setBusy(what);
    setMessage(null);
    try {
      const res = await fetch(url, { ...init, cache: "no-store" });
      const body = (await res.json().catch(() => ({}))) as Api;
      if (!res.ok) throw new Error(body.message ?? `The change was not accepted (HTTP ${res.status})`);
      const next = fromApi(body);
      setSaved(next);
      setName(next.agencyName);
      setPrefix(next.inventoryPrefix);
      setMessage({ ok: true, text: done });
      router.refresh();
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : "The change could not be saved" });
    } finally {
      setBusy(null);
    }
  }

  const dirty = name !== saved.agencyName || prefix !== saved.inventoryPrefix;

  return (
    <div className="edit">
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          void call("save", "/api/dashboard/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agency_name: name, inventory_prefix: prefix }) }, "Saved.");
        }}
      >
        <label>
          Agency name
          <input value={name} maxLength={100} onChange={(e) => setName(e.target.value)} required />
        </label>
        <label>
          Inventory prefix ({limits.prefixMin}-{limits.prefixMax} letters or digits)
          <input value={prefix} maxLength={limits.prefixMax} className="mono" onChange={(e) => setPrefix(e.target.value.toUpperCase())} required />
        </label>
        <button type="submit" className="btn" disabled={busy !== null || !dirty}>
          {busy === "save" ? "Saving…" : "Save"}
        </button>
      </form>
      <p className="sub">
        New inventory numbers look like <span className="mono">{prefix || "…"}-YYYY-00001</span>. Changing the prefix does not rename numbers already issued.
      </p>

      <div className="row">
        <div>
          <p className="sub">Logo</p>
          {saved.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={saved.logoUrl} alt="Current logo" className="logo-preview" />
          ) : (
            <p className="sub">No logo set.</p>
          )}
        </div>
        <label>
          Upload PNG, JPEG or WebP (max {limits.logoKb} KB)
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            disabled={busy !== null}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void call("logo", "/api/dashboard/settings/logo", { method: "POST", headers: { "content-type": file.type }, body: file }, "Logo saved.");
            }}
          />
        </label>
        {saved.logoUrl && (
          <button type="button" className="btn" disabled={busy !== null} onClick={() => void call("remove", "/api/dashboard/settings/logo", { method: "DELETE" }, "Logo removed.")}>
            Remove logo
          </button>
        )}
      </div>
      {message && (
        <p role={message.ok ? "status" : "alert"} className="sub">
          {message.text}
        </p>
      )}
    </div>
  );
}
