import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/db";
import type { Component } from "@/db/schema";
import { RequestActions, type RequestRow } from "../_components/request-actions";
import {
  CATEGORY_LABEL,
  CONNECTION_LABEL,
  CONNECTION_TYPE_LABEL,
  connectionState,
  formatBytes,
  formatDateTime,
  OS_LABEL,
  REQUEST_LABEL,
  REQUEST_STATUS_LABEL,
  STATUS_LABEL,
} from "@/lib/format";
import { REQUEST_TYPES } from "@/lib/requests";
import { getDeviceDetail, getDeviceLogs, getLatestRequests, getNetworkHistory, LOG_LIMIT, NETWORK_LIMIT } from "@/lib/queries";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// CPU model strings already name the vendor ("13th Gen Intel(R) Core(TM) i5-13500").
function componentName(c: Component): string {
  const parts = c.category === "cpu" ? [c.model] : [c.manufacturer, c.model];
  return parts.filter(Boolean).join(" ") || "—";
}

function componentSummary(c: Component): string {
  const d = c.details as Record<string, string | number | null>;
  switch (c.category) {
    case "cpu":
      return [d.cores && `${d.cores} cores`, d.threads && `${d.threads} threads`, d.base_speed_mhz && `${d.base_speed_mhz} MHz`].filter(Boolean).join(", ");
    case "ram":
      return [d.slot, d.speed_mhz && `${d.speed_mhz} MHz`].filter(Boolean).join(", ");
    case "storage":
      return [typeof d.media_type === "string" && d.media_type.toUpperCase(), d.bus_type].filter(Boolean).join(", ");
    case "gpu":
      return d.driver_version ? `Driver ${d.driver_version}` : "";
    case "nic":
      return d.type === "wifi" ? "Wi-Fi" : d.type === "ethernet" ? "Ethernet" : "";
    default:
      return "";
  }
}

const LEVELS = ["error", "warning", "info"] as const;

export default async function DevicePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ level?: string }>;
}) {
  const { id } = await params;
  const { level: levelParam } = await searchParams;
  if (!UUID_RE.test(id)) notFound();
  const db = getDb();
  const detail = await getDeviceDetail(db, id);
  if (!detail) notFound();
  const level = LEVELS.find((l) => l === levelParam);
  const [latestRequests, logs, network] = await Promise.all([getLatestRequests(db, id), getDeviceLogs(db, id, level), getNetworkHistory(db, id)]);
  const requestRows: RequestRow[] = REQUEST_TYPES.map((type) => {
    const r = latestRequests.get(type);
    const when = r ? (r.completedAt ?? r.deliveredAt ?? r.createdAt) : null;
    return {
      type,
      label: REQUEST_LABEL[type],
      status: r?.status ?? null,
      statusLabel: r ? REQUEST_STATUS_LABEL[r.status] : "",
      detail: r ? [`asked ${formatDateTime(r.createdAt)}`, when && when !== r.createdAt ? `updated ${formatDateTime(when)}` : null, r.message].filter(Boolean).join(" · ") : "",
    };
  });
  const state = connectionState(detail.device);

  const { device, assignment, active, removed, latestScan } = detail;
  const p = latestScan?.payload;

  return (
    <>
      <div>
        <p className="sub">
          <Link href="/devices">Devices</Link> /
        </p>
        <h1>{device.hostname}</h1>
        <p className="sub">
          {OS_LABEL[device.osType]} · {[device.manufacturer, device.model].filter(Boolean).join(" ") || "Unknown model"} ·{" "}
          <span className="pill">{STATUS_LABEL[device.status]}</span>{" "}
          <span className={`pill ${state === "online" ? "ok" : state === "stale" ? "warn" : "off"}`}>{CONNECTION_LABEL[state]}</span>
        </p>
      </div>

      <section>
        <h2>Requests</h2>
        <div className="panel pad">
          <RequestActions deviceId={device.id} rows={requestRows} />
          {state !== "online" && <p className="sub">This computer is {CONNECTION_LABEL[state].toLowerCase()}; a request waits until it connects.</p>}
        </div>
      </section>

      <div className="grid">
        <section className="panel pad">
          <h2>Assigned user</h2>
          {assignment ? (
            <dl>
              <dt>Name</dt>
              <dd>{assignment.user.fullName}</dd>
              <dt>Employee ID</dt>
              <dd className="mono">{assignment.user.employeeId}</dd>
              <dt>Department</dt>
              <dd>{assignment.user.department}</dd>
              <dt>Position</dt>
              <dd>{assignment.user.position ?? "—"}</dd>
              <dt>Email</dt>
              <dd>{assignment.user.email ?? "—"}</dd>
              <dt>Phone</dt>
              <dd>{assignment.user.phone ?? "—"}</dd>
              <dt>Since</dt>
              <dd>{formatDateTime(assignment.startAt)}</dd>
            </dl>
          ) : (
            <p className="sub">Unassigned</p>
          )}
        </section>

        <section className="panel pad">
          <h2>System</h2>
          <dl>
            <dt>Serial number</dt>
            <dd className="mono">{device.serialNumber ?? "—"}</dd>
            <dt>Inventory no.</dt>
            <dd className="mono">{device.inventoryNumber ?? "Not tagged"}</dd>
            <dt>OS</dt>
            <dd>{p ? [p.system.os_name, p.system.os_version, p.system.os_build && `(${p.system.os_build})`].filter(Boolean).join(" ") : "—"}</dd>
            <dt>Firmware</dt>
            <dd className="mono">{p?.system.firmware_version ?? "—"}</dd>
            <dt>Agent</dt>
            <dd className="mono">{device.agentVersion ?? p?.agent_version ?? "—"}</dd>
            <dt>Last scan</dt>
            <dd>{formatDateTime(device.lastFullScanAt)}</dd>
            <dt>Last seen</dt>
            <dd>{formatDateTime(device.lastSeenAt)}</dd>
            <dt>Device ID</dt>
            <dd className="mono">{device.deviceUuid}</dd>
          </dl>
        </section>
      </div>

      <section>
        <h2>Components</h2>
        <div className="panel">
          {active.length === 0 ? (
            <p className="empty">No scan received yet.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Model</th>
                  <th>Details</th>
                  <th>Capacity</th>
                  <th>Serial / MAC</th>
                  <th>First seen</th>
                </tr>
              </thead>
              <tbody>
                {active.map((c) => (
                  <tr key={c.id}>
                    <td>
                      {CATEGORY_LABEL[c.category]}
                      {c.isIntegrated && (
                        <>
                          {" "}
                          <span className="pill muted">Integrated</span>
                        </>
                      )}
                    </td>
                    <td>{componentName(c)}</td>
                    <td>{componentSummary(c) || "—"}</td>
                    <td className="num">{formatBytes(c.capacityBytes)}</td>
                    <td className="mono">{c.serialNumber ?? "—"}</td>
                    <td className="num">{formatDateTime(c.firstSeenAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      {p && (
        <div className="grid">
          <section className="panel pad">
            <h2>Volumes</h2>
            <dl>
              {p.volumes.map((v) => (
                <div key={v.mount_point} style={{ display: "contents" }}>
                  <dt className="mono">{v.mount_point}</dt>
                  <dd>
                    {formatBytes(v.free_bytes)} free of {formatBytes(v.size_bytes)}
                    {v.label && ` · ${v.label}`}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
          <section className="panel pad">
            <h2>Network</h2>
            <dl>
              {p.network.adapters
                .filter((a) => a.ip_addresses.length > 0)
                .map((a) => (
                  <div key={a.name} style={{ display: "contents" }}>
                    <dt>{a.type === "wifi" ? "Wi-Fi" : a.type === "ethernet" ? "Ethernet" : a.name}</dt>
                    <dd className="mono">{a.ip_addresses.join(", ")}</dd>
                  </div>
                ))}
              <dt>Gateway</dt>
              <dd className="mono">{p.network.adapters.find((a) => a.gateway)?.gateway ?? "—"}</dd>
              <dt>Wi-Fi network</dt>
              <dd>{p.network.wifi_ssid ?? "—"}</dd>
            </dl>
          </section>
        </div>
      )}

      {removed.length > 0 && (
        <section>
          <h2>Removed components</h2>
          <div className="panel">
            <table>
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Model</th>
                  <th>Serial / MAC</th>
                  <th>First seen</th>
                  <th>Removed</th>
                </tr>
              </thead>
              <tbody>
                {removed.map((c) => (
                  <tr key={c.id}>
                    <td>{CATEGORY_LABEL[c.category]}</td>
                    <td>{componentName(c)}</td>
                    <td className="mono">{c.serialNumber ?? "—"}</td>
                    <td className="num">{formatDateTime(c.firstSeenAt)}</td>
                    <td className="num">{formatDateTime(c.removedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section>
        <h2>Network</h2>
        <p className="sub">Snapshots sent when the PC connected and whenever its network changed (newest {NETWORK_LIMIT}).</p>
        <div className="panel">
          {network.length === 0 ? (
            <p className="empty">No network snapshot received yet.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Collected</th>
                  <th>Connection</th>
                  <th>IP addresses</th>
                  <th>MAC</th>
                  <th>Gateway</th>
                  <th>DNS</th>
                  <th>Wi-Fi</th>
                </tr>
              </thead>
              <tbody>
                {network.map((n) => (
                  <tr key={n.id}>
                    <td className="num">{formatDateTime(n.collectedAt)}</td>
                    <td>{CONNECTION_TYPE_LABEL[n.connectionType]}</td>
                    <td className="mono">{n.ipAddresses.join(", ") || "—"}</td>
                    <td className="mono">{n.macAddresses.join(", ") || "—"}</td>
                    <td className="mono">{n.gateway ?? "—"}</td>
                    <td className="mono">{n.dnsServers.join(", ") || "—"}</td>
                    <td>{n.ssid ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      <section>
        <h2>Logs</h2>
        <p className="sub">Uploaded when requested with “Send logs” (newest {LOG_LIMIT}).</p>
        <nav className="filters" aria-label="Filter logs by level">
          {[undefined, ...LEVELS].map((l) => (
            <Link key={l ?? "all"} href={l ? `/devices/${device.id}?level=${l}#logs` : `/devices/${device.id}#logs`} aria-current={l === level}>
              {l ? l[0].toUpperCase() + l.slice(1) : "All"}
            </Link>
          ))}
        </nav>
        <div className="panel" id="logs" style={{ marginTop: 8 }}>
          {logs.length === 0 ? (
            <p className="empty">No logs{level ? ` at level “${level}”` : ""} uploaded yet.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Level</th>
                  <th>Category</th>
                  <th>Message</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((l) => (
                  <tr key={l.id}>
                    <td className="num">{formatDateTime(l.loggedAt)}</td>
                    <td>
                      <span className={`pill${l.level === "error" || l.level === "warning" ? " warn" : " muted"}`}>{l.level}</span>
                    </td>
                    <td>{l.category}</td>
                    <td className="msg">{l.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      {latestScan && (
        <section className="panel pad">
          <details>
            <summary>
              Latest raw scan · {latestScan.scanType} · collected {formatDateTime(latestScan.collectedAt)}
            </summary>
            <pre>{JSON.stringify(latestScan.payload, null, 2)}</pre>
          </details>
        </section>
      )}
    </>
  );
}
