import Link from "next/link";
import { getDb } from "@/db";
import { requireStaff } from "@/lib/staff-auth";
import { CONNECTION_LABEL, connectionState, formatDateTime, OS_LABEL, STATUS_LABEL, type ConnectionState } from "@/lib/format";
import { DEVICE_STATUSES, isDeviceStatus } from "@/lib/inventory";
import { listDepartments, listDevices } from "@/lib/queries";

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

const BAD_STATUS = new Set(["for_disposal", "disposed", "lost"]);

type Params = { connection?: string; status?: string; department?: string; os?: string; q?: string };

export default async function DevicesPage({ searchParams }: { searchParams: Promise<Params> }) {
  await requireStaff("/devices");
  const params = await searchParams;
  const filter = params.connection === "online" || params.connection === "offline" || params.connection === "stale" ? params.connection : undefined;
  const status = isDeviceStatus(params.status) ? params.status : undefined;
  const os = params.os === "windows" || params.os === "macos" ? params.os : undefined;
  const department = params.department || undefined;
  const q = params.q?.trim() || undefined;
  const db = getDb();
  const [rows, departments] = await Promise.all([listDevices(db, { connection: filter, status, os, department, q }), listDepartments(db)]);
  const filtered = Boolean(filter || status || os || department || q);
  // Connection links keep the other filters.
  const href = (conn?: string) => {
    const sp = new URLSearchParams();
    if (conn) sp.set("connection", conn);
    for (const [k, v] of Object.entries({ status, department, os, q })) if (v) sp.set(k, v);
    const qs = sp.toString();
    return qs ? `/devices?${qs}` : "/devices";
  };

  return (
    <>
      <div>
        <h1>Devices</h1>
        <p className="sub">
          {rows.length} {filtered ? "matching" : "registered"} {rows.length === 1 ? "computer" : "computers"}
        </p>
        <form className="search" action="/devices" method="get">
          {filter && <input type="hidden" name="connection" value={filter} />}
          <label>
            Search
            <input type="search" name="q" defaultValue={q} placeholder="Number, hostname, user, employee ID, serial" style={{ minWidth: 300 }} />
          </label>
          <label>
            Status
            <select name="status" defaultValue={status ?? ""}>
              <option value="">Any</option>
              {DEVICE_STATUSES.map((st) => (
                <option key={st} value={st}>
                  {STATUS_LABEL[st]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Department
            <select name="department" defaultValue={department ?? ""}>
              <option value="">Any</option>
              {departments.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </label>
          <label>
            OS
            <select name="os" defaultValue={os ?? ""}>
              <option value="">Any</option>
              <option value="windows">{OS_LABEL.windows}</option>
              <option value="macos">{OS_LABEL.macos}</option>
            </select>
          </label>
          <button type="submit" className="btn">
            Apply
          </button>
          {filtered && <Link href="/devices">Clear</Link>}
        </form>
        <nav className="filters" aria-label="Filter by connection">
          {FILTERS.map((f) => (
            <Link key={f.label} href={href(f.key)} aria-current={f.key === filter}>
              {f.label}
            </Link>
          ))}
        </nav>
      </div>
      <div className="panel">
        {rows.length === 0 ? (
          <p className="empty">
            {filtered ? (
              "No computers match these filters."
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
                <th>Inventory no.</th>
                <th>Hostname</th>
                <th>OS</th>
                <th>Model</th>
                <th>Assigned to</th>
                <th>Department</th>
                <th>Location</th>
                <th>Status / connection</th>
                <th>Agent</th>
                <th>Last scan</th>
                <th>Last seen</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.id}>
                  <td className="mono">{d.inventoryNumber ?? "—"}</td>
                  <td>
                    <Link href={`/devices/${d.id}`}>{d.hostname}</Link>
                  </td>
                  <td>{OS_LABEL[d.osType]}</td>
                  <td>{[d.manufacturer, d.model].filter(Boolean).join(" ") || "—"}</td>
                  <td>
                    {d.userName ?? "Unassigned"}
                    {d.employeeId && <div className="mono sub">{d.employeeId}</div>}
                  </td>
                  <td>{d.department ?? "—"}</td>
                  <td>{d.location ?? "—"}</td>
                  <td>
                    <span className={`pill${BAD_STATUS.has(d.status) ? " status-bad" : ""}`}>{STATUS_LABEL[d.status]}</span>{" "}
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
