import type { Metadata } from "next";
import { getDb } from "@/db";
import { listFields } from "@/lib/custom-fields";
import { secretsDisabledReason } from "@/lib/secrets-crypto";
import { FieldsManager } from "./fields-manager";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Fields" };

export default async function FieldsPage() {
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
          Secret values are encrypted on the server and shown only with the current IT PIN. There is no dashboard login yet, so anyone who can open this dashboard can also read the IT PIN; every reveal is logged on the device page.
        </p>
      </section>
    </>
  );
}
