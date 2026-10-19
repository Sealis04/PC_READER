import Link from "next/link";
import { getDb } from "@/db";
import { CONNECTION_LABEL, connectionState, formatDateTime, OS_LABEL, STATUS_LABEL, type ConnectionState } from "@/lib/format";
import { listDevices } from "@/lib/queries";

export const dynamic = "force-dynamic";

const FILTERS: Array<{ key: ConnectionState | undefined; label: string }> = [
  { key: undefined, label: "All" },
  { key: "online", label: "Online" },
  { key: "offline", label: "Offline" },
  { key: "stale", label: "Stale (offline over 48 h)" },
];

function ConnectionPill({ device }: { device: { online: boolean; lastSeenAt: Date | null } }) {
  const state = connectionState(device);
  const cls = state === "online" ? "ok" : state === "stale" ? "warn" : "off";
  return <span className={`pill ${cls}`}>{CONNECTION_LABEL[state]}</span>;
}

export default async function DevicesPage({ searchParams }: { searchParams: Promise<{ connection?: string }> }) {
  const { connection } = await searchParams;
  const filter = connection === "online" || connection === "offline" || connection === "stale" ? connection : undefined;
  const rows = await listDevices(getDb(), filter);

  return (
    <>
      <div>
        <h1>Devices</h1>
        <p className="sub">
          {rows.length} {filter ? CONNECTION_LABEL[filter].toLowerCase() : "registered"} {rows.length === 1 ? "computer" : "computers"}
        </p>
        <nav className="filters" aria-label="Filter by connection">
          {FILTERS.map((f) => (
            <Link key={f.label} href={f.key ? `/devices?connection=${f.key}` : "/devices"} aria-current={f.key === filter}>
              {f.label}
            </Link>
          ))}
        </nav>
      </div>
      <div className="panel">
        {rows.length === 0 ? (
          <p className="empty">
            {filter ? (
              "No computers match this filter."
            ) : (
              <>
                No devices yet. Run <span className="mono">pcreader register</span> on a computer to add it.
              </>
            )}
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
                <th>Connection</th>
                <th>Agent</th>
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
                  <td>
                    <ConnectionPill device={d} />
                  </td>
                  <td className="mono">{d.agentVersion ?? "—"}</td>
                  <td className="num">{formatDateTime(d.lastFullScanAt)}</td>
                  <td className="num">{formatDateTime(d.lastSeenAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
