import type { Metadata } from "next";
import Link from "next/link";
import { getDb } from "@/db";
import { logoUrl, getSettings, MAX_LOGO_BYTES, MAX_PREFIX_LENGTH, MIN_PREFIX_LENGTH } from "@/lib/settings";
import { RecoveryKeyReveal } from "@/app/_components/recovery-key-reveal";
import { formatDateTime } from "@/lib/format";
import { recoveryStatus } from "@/lib/recovery-key";
import { RotateRecoveryKey } from "./recovery-key-card";
import { SettingsForm } from "./settings-form";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  const db = getDb();
  const [s, rk] = await Promise.all([getSettings(db), recoveryStatus(db)]);
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
      <section>
        <h2>Recovery key</h2>
        <div className="panel pad">
          <p className="sub">
            The recovery key signs up new PCs (as the enrollment key) and opens a PC&apos;s Settings when its server cannot be reached. A new key is made
            every 30 days; PCs receive only a hash of it. An older key still opens the PCs that hold it, but never signs up a PC.
          </p>
          {rk.enabled ? (
            <>
              <dl>
                <dt>Current version</dt>
                <dd className="mono">v{rk.version}</dd>
                <dt>Created</dt>
                <dd>
                  {formatDateTime(rk.createdAt)} ({rk.source === "seed" ? "first key" : rk.source === "manual" ? "made by IT" : "automatic"})
                </dd>
                <dt>Next new key</dt>
                <dd>{formatDateTime(rk.nextRotationAt)}</dd>
                <dt>PCs behind</dt>
                <dd>
                  {rk.behind === 0 ? "None" : <Link href="/devices?recovery=behind">{rk.behind} {rk.behind === 1 ? "PC holds" : "PCs hold"} an older or unknown key</Link>}
                </dd>
              </dl>
              <RecoveryKeyReveal url="/api/dashboard/recovery-key/reveal" label="Show key" />
              <RotateRecoveryKey />
              {rk.envDiffers && (
                <p className="sub">
                  ENROLLMENT_KEY in the server&apos;s env file differs from the current key. It only set the first key of a new database and is ignored now.
                </p>
              )}
            </>
          ) : (
            <p className="error">
              Recovery keys are not stored, so ENROLLMENT_KEY from the env file stays the key and does not rotate: {rk.disabledReason}.
            </p>
          )}
        </div>
      </section>
    </>
  );
}
