import type { Metadata } from "next";
import { getDb } from "@/db";
import { listFields } from "@/lib/custom-fields";
import { secretsDisabledReason } from "@/lib/secrets-crypto";
import { requireStaff } from "@/lib/staff-auth";
import { FieldsManager } from "./fields-manager";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Fields" };

export default async function FieldsPage() {
  await requireStaff("/fields");
  const fields = await listFields(getDb(), { includeArchived: true });
  const secretsReason = secretsDisabledReason();
  return (
    <>
      <div>
        <h1>Fields</h1>
        <p className="sub">
          Extra fields for every computer: Text, Date or Secret. Fill them in on each device&apos;s page. Archiving hides a field but keeps its values; fields are never deleted.
        </p>
      </div>
      <section className="panel pad">
        <FieldsManager initial={fields.map((f) => ({ id: f.id, name: f.name, type: f.type, archived: f.archivedAt !== null }))} secretsReason={secretsReason} />
        <p className="sub">
          Secret values are encrypted on the server and shown only with the current IT PIN. Revealing or changing one needs the IT PIN on top of your HRIS login; every attempt is logged on the device page with who made it.
        </p>
      </section>
    </>
  );
}
