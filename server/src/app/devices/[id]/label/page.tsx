import Link from "next/link";
import { notFound } from "next/navigation";
import QRCode from "qrcode";
import { getDb } from "@/db";
import { requireStaff } from "@/lib/staff-auth";
import { devices } from "@/db/schema";
import { eq } from "drizzle-orm";
import { PrintButton } from "../../_components/print-button";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Sticker label: the QR code encodes the inventory number only (generated here, no external service).
export default async function LabelPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireStaff(`/devices/${id}/label`);
  if (!UUID_RE.test(id)) notFound();
  const [device] = await getDb().select().from(devices).where(eq(devices.id, id)).limit(1);
  if (!device) notFound();
  const svg = device.inventoryNumber ? await QRCode.toString(device.inventoryNumber, { type: "svg", margin: 0, errorCorrectionLevel: "M" }) : null;

  return (
    <>
      <div className="no-print">
        <p className="sub">
          <Link href={`/devices/${id}`}>{device.hostname}</Link> /
        </p>
        <h1>Label</h1>
        {svg ? <PrintButton /> : <p className="sub">This device has no inventory number yet. Assign one on the device page first.</p>}
      </div>
      {svg && device.inventoryNumber && (
        <div className="label" aria-label={`Label for ${device.inventoryNumber}`}>
          <div className="qr" dangerouslySetInnerHTML={{ __html: svg }} />
          <div className="text">
            <div className="number">{device.inventoryNumber}</div>
            <div>{device.hostname}</div>
            <div>S/N: {device.serialNumber ?? "—"}</div>
            <div className="brand">PC_READER</div>
          </div>
        </div>
      )}
    </>
  );
}
