import Link from "next/link";
import { getDb } from "@/db";
import { formatDateTime, isStale, OS_LABEL, STATUS_LABEL } from "@/lib/format";
import { listDevices } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function DevicesPage() {
  const rows = await listDevices(getDb());

  return (
    <>
      <div>
        <h1>Devices</h1>
        <p className="sub">
          {rows.length} registered {rows.length === 1 ? "computer" : "computers"}
        </p>
      </div>
      <div className="panel">
        {rows.length === 0 ? (
          <p className="empty">
            No devices yet. Run <span className="mono">pcreader register</span> on a computer to add it.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Hostname</th>
                <th>OS</th>
                <th>Model</th>
                <th>Assigned to</th>
                <th>Department</th>
                <th>Status</th>
                <th>Last scan</th>
                <th>Last seen</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.id}>
                  <td>
                    <Link href={`/devices/${d.id}`}>{d.hostname}</Link>
                    {d.inventoryNumber && <div className="mono sub">{d.inventoryNumber}</div>}
                  </td>
                  <td>{OS_LABEL[d.osType]}</td>
                  <td>{[d.manufacturer, d.model].filter(Boolean).join(" ") || "—"}</td>
                  <td>{d.userName ?? "Unassigned"}</td>
                  <td>{d.department ?? "—"}</td>
                  <td>
                    <span className="pill">{STATUS_LABEL[d.status]}</span>
                  </td>
                  <td className="num">{formatDateTime(d.lastFullScanAt)}</td>
                  <td className="num">
                    {formatDateTime(d.lastSeenAt)}
                    {isStale(d.lastSeenAt) && (
                      <>
                        {" "}
                        <span className="pill warn">Stale</span>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
