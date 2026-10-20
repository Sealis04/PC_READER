import type { Metadata } from "next";
import { getDb } from "@/db";
import { requireStaff } from "@/lib/staff-auth";
import { logoUrl, getSettings, MAX_LOGO_BYTES, MAX_PREFIX_LENGTH, MIN_PREFIX_LENGTH } from "@/lib/settings";
import { formatDateTime } from "@/lib/format";
import { EVENT_LABEL, latestStaffEvents } from "@/lib/staff-events";
import { SettingsForm } from "./settings-form";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  await requireStaff("/settings");
  const db = getDb();
  const s = await getSettings(db);
  const activity = await latestStaffEvents(db);
  return (
    <>
      <div>
        <h1>Settings</h1>
        <p className="sub">The agency name and logo appear on this dashboard and in the PC app&apos;s window. The prefix starts new inventory numbers.</p>
      </div>
      <section className="panel pad">
        <SettingsForm
          initial={{ agencyName: s.agencyName, inventoryPrefix: s.inventoryPrefix, logoUrl: logoUrl(s) }}
          limits={{ logoKb: MAX_LOGO_BYTES / 1024, prefixMin: MIN_PREFIX_LENGTH, prefixMax: MAX_PREFIX_LENGTH }}
        />
      </section>
      <section className="panel pad">
        <h2>Staff activity</h2>
        <p className="sub">Sign-ins and changes made on this dashboard (latest 100), newest first.</p>
        {activity.length === 0 ? (
          <p className="sub">Nothing yet.</p>
        ) : (
          <ul className="timeline">
            {activity.map((e) => (
              <li key={e.id}>
                <span className="num sub">{formatDateTime(e.at)}</span>
                <span>
                  {e.name ?? e.hrisSub ?? "Unknown"} · {EVENT_LABEL[e.type]}
                  {e.detail && <span className="sub"> · {e.detail}</span>}
                  {e.clientIp && <span className="sub"> · {e.clientIp}</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
