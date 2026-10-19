"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

const STATUS_OPTIONS = [
  { value: "in_use", label: "In use" },
  { value: "spare", label: "Spare" },
  { value: "under_repair", label: "Under repair" },
  { value: "for_disposal", label: "For disposal" },
  { value: "disposed", label: "Disposed" },
  { value: "lost", label: "Lost" },
] as const;

interface Props {
  deviceId: string;
  inventoryNumber: string | null;
  status: string;
  location: string | null;
}

// Edit panel: one change per button, each sent to the inventory API with the optional reason.
// The server's message (duplicate number, ...) is shown inline.
export function InventoryPanel({ deviceId, inventoryNumber, status, location }: Props) {
  const router = useRouter();
  const [number, setNumber] = useState("");
  const [newStatus, setNewStatus] = useState(status);
  const [newLocation, setNewLocation] = useState(location ?? "");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function send(action: string, extra: Record<string, unknown> = {}, done?: string) {
    setBusy(action);
    setMessage(null);
    try {
      const res = await fetch(`/api/dashboard/devices/${deviceId}/inventory`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, reason: reason || undefined, ...extra }),
      });
      const body = (await res.json().catch(() => ({}))) as { message?: string; changed?: boolean; inventoryNumber?: string };
      if (!res.ok) throw new Error(body.message ?? `The change was not accepted (HTTP ${res.status})`);
      setMessage({ ok: true, text: body.changed === false ? "Nothing to change." : (done ?? "Saved.") + (body.inventoryNumber && action === "assign_next" ? ` ${body.inventoryNumber}` : "") });
      if (body.changed !== false) {
        setReason("");
        if (action === "set_number" || action === "clear_number" || action === "assign_next") setNumber("");
      }
      router.refresh();
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : "The change could not be saved" });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="edit">
      <div className="row">
        <label>
          Inventory number
          <input value={number} onChange={(e) => setNumber(e.target.value)} placeholder="Existing sticker number" maxLength={50} />
        </label>
        <button type="button" className="btn" disabled={busy !== null || !number.trim()} onClick={() => send("set_number", { value: number }, "Number saved.")}>
          {inventoryNumber ? "Change number" : "Use this number"}
        </button>
        {!inventoryNumber && (
          <button type="button" className="btn" disabled={busy !== null} onClick={() => send("assign_next", {}, "Assigned")}>
            Assign next number
          </button>
        )}
        {inventoryNumber && (
          <button type="button" className="btn" disabled={busy !== null} onClick={() => send("clear_number", {}, "Number removed.")}>
            Remove number
          </button>
        )}
      </div>
      <div className="row">
        <label>
          Status
          <select value={newStatus} onChange={(e) => setNewStatus(e.target.value)}>
            {STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="btn" disabled={busy !== null || newStatus === status} onClick={() => send("set_status", { status: newStatus }, "Status saved.")}>
          Change status
        </button>
      </div>
      <div className="row">
        <label>
          Location
          <input value={newLocation} onChange={(e) => setNewLocation(e.target.value)} placeholder="e.g. Records Section, 2F" maxLength={200} />
        </label>
        <button type="button" className="btn" disabled={busy !== null || newLocation.trim() === (location ?? "")} onClick={() => send("set_location", { value: newLocation }, "Location saved.")}>
          Save location
        </button>
      </div>
      <div className="row">
        <label>
          Reason (optional, kept in the history)
          <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
        </label>
      </div>
      {message && (
        <p role={message.ok ? "status" : "alert"} className={message.ok ? "sub" : "error"}>
          {message.text}
        </p>
      )}
    </div>
  );
}
