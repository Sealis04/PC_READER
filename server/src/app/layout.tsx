import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "PC_READER",
  description: "Agency device inventory",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="top">
          <div className="inner">
            <Link href="/devices" className="brand">
              PC_READER
            </Link>
            <nav>
              <Link href="/devices">Devices</Link>
              <Link href="/it-pin">IT PIN</Link>
            </nav>
          </div>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
