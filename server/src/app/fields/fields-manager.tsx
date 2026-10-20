"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type FieldType = "text" | "date" | "secret";
interface Field {
  id: string;
  name: string;
  type: FieldType;
  archived: boolean;
}

const TYPE_LABEL: Record<FieldType, string> = { text: "Text", date: "Date", secret: "Secret" };

// The field definitions: add, rename, reorder and archive. The server's message is shown inline.
export function FieldsManager({ initial, secretsReason }: { initial: Field[]; secretsReason: string | null }) {
  const router = useRouter();
  const [fields, setFields] = useState(initial);
  const [name, setName] = useState("");
  const [type, setType] = useState<FieldType>("text");
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function call(url: string, method: string, body: unknown, done: string): Promise<Response | null> {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body), cache: "no-store" });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(b.message ?? `The change was not accepted (HTTP ${res.status})`);
      }
      setMessage({ ok: true, text: done });
      router.refresh();
      return res;
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : "The change could not be saved" });
      return null;
    } finally {
      setBusy(false);
    }
  }

  const replace = (f: Field) => setFields((all) => all.map((x) => (x.id === f.id ? f : x)));
  const apiField = (b: { id: string; name: string; type: FieldType; archived: boolean }): Field => ({ id: b.id, name: b.name, type: b.type, archived: b.archived });

  async function add() {
    const res = await call("/api/dashboard/fields", "POST", { name, type }, "Field added.");
    if (res) {
      const created = apiField((await res.json()) as Field);
      setFields((all) => [...all, created]);
      setName("");
    }
  }

  async function rename(id: string, newName: string) {
    const res = await call(`/api/dashboard/fields/${id}`, "PATCH", { name: newName }, "Renamed.");
    if (res) {
      replace(apiField((await res.json()) as Field));
      setRenaming(null);
    }
  }

  async function archive(f: Field, archived: boolean) {
    const res = await call(`/api/dashboard/fields/${f.id}`, "PATCH", { archived }, archived ? "Archived; its values are kept." : "Restored.");
    if (res) replace(apiField((await res.json()) as Field));
  }

  // Moves an active field one place; archived fields keep their place at the end of the order.
  async function move(id: string, delta: -1 | 1) {
    const active = fields.filter((f) => !f.archived);
    const i = active.findIndex((f) => f.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= active.length) return;
    const next = [...active];
    [next[i], next[j]] = [next[j], next[i]];
    const res = await call("/api/dashboard/fields/order", "POST", { ids: next.map((f) => f.id) }, "Order saved.");
    if (res) setFields([...next, ...fields.filter((f) => f.archived)]);
  }

  const active = fields.filter((f) => !f.archived);
  const archived = fields.filter((f) => f.archived);

  return (
    <div className="edit">
      {secretsReason && (
        <p role="alert" className="error">
          Secret fields are disabled: {secretsReason}.
        </p>
      )}
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <label>
          New field
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Warranty until" maxLength={100} />
        </label>
        <label>
          Type
          <select value={type} onChange={(e) => setType(e.target.value as FieldType)}>
            <option value="text">Text</option>
            <option value="date">Date</option>
            <option value="secret" disabled={secretsReason !== null}>
              Secret
            </option>
          </select>
        </label>
        <button type="submit" className="btn" disabled={busy || !name.trim()}>
          Add field
        </button>
      </form>
      {message && (
        <p role={message.ok ? "status" : "alert"} className={message.ok ? "sub" : "error"}>
          {message.text}
        </p>
      )}
      {active.length === 0 ? (
        <p className="sub">No fields yet.</p>
      ) : (
        <ul className="timeline">
          {active.map((f, i) => (
            <li key={f.id}>
              <span className="sub">{TYPE_LABEL[f.type]}</span>
              <span className="row" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                {renaming?.id === f.id ? (
                  <>
                    <input value={renaming.name} onChange={(e) => setRenaming({ id: f.id, name: e.target.value })} maxLength={100} aria-label={`New name for ${f.name}`} />
                    <button type="button" className="btn" disabled={busy || !renaming.name.trim()} onClick={() => void rename(f.id, renaming.name)}>
                      Save
                    </button>
                    <button type="button" className="btn" onClick={() => setRenaming(null)}>
                      Cancel
                    </button>
                  </>
                ) : (
                  <>
                    <strong>{f.name}</strong>
                    <button type="button" className="btn" disabled={busy} onClick={() => setRenaming({ id: f.id, name: f.name })}>
                      Rename
                    </button>
                    <button type="button" className="btn" disabled={busy || i === 0} onClick={() => void move(f.id, -1)} aria-label={`Move ${f.name} up`}>
                      Up
                    </button>
                    <button type="button" className="btn" disabled={busy || i === active.length - 1} onClick={() => void move(f.id, 1)} aria-label={`Move ${f.name} down`}>
                      Down
                    </button>
                    <button type="button" className="btn" disabled={busy} onClick={() => void archive(f, true)}>
                      Archive
                    </button>
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {archived.length > 0 && (
        <>
          <h3>Archived</h3>
          <ul className="timeline">
            {archived.map((f) => (
              <li key={f.id}>
                <span className="sub">{TYPE_LABEL[f.type]}</span>
                <span>
                  {f.name}{" "}
                  <button type="button" className="btn" disabled={busy} onClick={() => void archive(f, false)}>
                    Restore
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
