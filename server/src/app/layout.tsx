import type { Metadata } from "next";
import Link from "next/link";
import { getDb } from "@/db";
import { safeBranding } from "@/lib/settings";
import "./globals.css";

// The agency name and logo come from the database (dashboard Settings), so nothing is prerendered.
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const { name } = await safeBranding(getDb);
  return {
    title: { default: name, template: `%s · ${name}` },
    description: "Device inventory",
  };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const { name, logo_url } = await safeBranding(getDb);
  return (
    <html lang="en">
      <body>
        <header className="top">
          <div className="inner">
            <Link href="/devices" className="brand">
              {logo_url && (
                // A plain <img>: the logo is served by our own API route and needs no optimisation.
                // eslint-disable-next-line @next/next/no-img-element
                <img src={logo_url} alt="" className="logo" />
              )}
              {name}
            </Link>
            <nav>
              <Link href="/devices">Devices</Link>
              <Link href="/it-pin">IT PIN</Link>
              <Link href="/fields">Fields</Link>
              <Link href="/settings">Settings</Link>
            </nav>
          </div>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
