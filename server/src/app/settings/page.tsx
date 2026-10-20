import type { Metadata } from "next";
import { getDb } from "@/db";
import { logoUrl, getSettings, MAX_LOGO_BYTES, MAX_PREFIX_LENGTH, MIN_PREFIX_LENGTH } from "@/lib/settings";
import { SettingsForm } from "./settings-form";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  const s = await getSettings(getDb());
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
        <p className="sub">There is no dashboard login yet, so anyone who can open this page can change these settings.</p>
      </section>
    </>
  );
}
