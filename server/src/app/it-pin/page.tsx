import { getDb } from "@/db";
import { currentPin } from "@/lib/it-pin";
import { TIME_ZONE } from "@/lib/format";
import { PinBox } from "./pin-box";

export const dynamic = "force-dynamic";

export default async function ItPinPage() {
  const { pin, expiresAt } = await currentPin(getDb());
  return (
    <>
      <div>
        <h1>IT PIN</h1>
        <p className="sub">Type this PIN in the PC_READER app on any computer to open its Settings. It changes every hour ({TIME_ZONE} time).</p>
      </div>
      <section className="panel pad">
        <PinBox initialPin={pin} initialExpiresAt={expiresAt.toISOString()} timeZone={TIME_ZONE} />
        <p className="sub">There is no dashboard login yet, so anyone who can open this page can see the PIN.</p>
      </section>
    </>
  );
}
