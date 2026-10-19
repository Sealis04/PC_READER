"use client";

import type { RequestType } from "@pcreader/contracts";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

export interface RequestRow {
  type: RequestType;
  label: string;
  status: "pending" | "delivered" | "done" | "failed" | null;
  statusLabel: string;
  detail: string;
}

// Buttons that queue a request for the PC, each with the state of its latest request. While a
// request is open the page refreshes itself every few seconds (the dashboard polls; the PC does not).
export function RequestActions({ deviceId, rows }: { deviceId: string; rows: RequestRow[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<RequestType | null>(null);
  const [error, setError] = useState<string | null>(null);
  const open = rows.some((r) => r.status === "pending" || r.status === "delivered");

  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => router.refresh(), 3000);
    return () => clearInterval(timer);
  }, [open, router]);

  async function queue(type: RequestType) {
    setBusy(type);
    setError(null);
    try {
      const res = await fetch(`/api/dashboard/devices/${deviceId}/requests`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type }),
      });
      if (!res.ok) throw new Error(`The request was not accepted (HTTP ${res.status})`);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The request could not be sent");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <table>
        <tbody>
          {rows.map((r) => {
            const isOpen = r.status === "pending" || r.status === "delivered";
            return (
              <tr key={r.type}>
                <td>
                  <button type="button" className="btn" disabled={busy === r.type || isOpen} onClick={() => queue(r.type)}>
                    {r.label}
                  </button>
                </td>
                <td>
                  {r.status ? (
                    <span className={`pill${r.status === "failed" ? " warn" : r.status === "done" ? "" : " muted"}`}>{r.statusLabel}</span>
                  ) : (
                    <span className="sub">Not requested yet</span>
                  )}{" "}
                  <span className="sub">{r.detail}</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {error && (
        <p role="alert" className="sub">
          {error}
        </p>
      )}
    </div>
  );
}
