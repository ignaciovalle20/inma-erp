import { redirect } from "next/navigation";
import { getSession, getCompanyForEdit, getClients, getClientAliases } from "@/lib/dal";
import { createClient } from "@/lib/supabase/server";
import Link from "next/link";
import { ImportSalesForm } from "./form";
import { NuboxImportForm } from "./nubox/form";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/Card";

function ModeTabs({ companyId, mode }: { companyId: string; mode: "nubox" | "csv" }) {
  const base = `/companies/${companyId}/sales/import`;
  const tab = (active: boolean) =>
    `rounded-md px-3 py-1.5 text-[13px] no-underline ${
      active
        ? "bg-[var(--color-surface)] font-semibold text-[var(--color-ink)] shadow-sm"
        : "text-[var(--color-muted)] hover:text-[var(--color-ink)]"
    }`;

  return (
    <div className="inline-flex gap-1 self-start rounded-lg bg-[var(--color-row)] p-1">
      <Link href={base} className={tab(mode === "nubox")}>
        Nubox
      </Link>
      <Link href={`${base}?modo=csv`} className={tab(mode === "csv")}>
        CSV genérico
      </Link>
    </div>
  );
}

export default async function ImportSalesPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ modo?: string }>;
}) {
  const { id } = await params;
  const { modo } = await searchParams;
  const mode = modo === "csv" ? "csv" : "nubox";
  const user = await getSession();

  if (!user) {
    redirect("/login");
  }

  const membership = await getCompanyForEdit(id);

  if (!membership) {
    redirect("/companies");
  }

  // Chile-only, gated on `country` (not `currency`) -- see spec
  // Decisions. Case-insensitive since the column is unconstrained text.
  if (membership.company.country?.toUpperCase() !== "CL") {
    redirect(`/companies/${id}/sales`);
  }

  if (mode === "nubox") {
    return (
      <div className="mx-auto flex w-full max-w-[1000px] flex-col gap-5">
        <PageHeader
          eyebrow="GESTIÓN / VENTAS"
          title="Importar ventas"
          subtitle={membership.company.name}
        />
        <ModeTabs companyId={id} mode={mode} />
        <Card padding="24px">
          <NuboxImportForm companyId={id} />
        </Card>
      </div>
    );
  }

  const clients = await getClients(id);
  const activeClients = clients
    .filter((client) => client.active)
    .map((client) => ({ id: client.id, name: client.name }));

  const activeClientIds = new Set(activeClients.map((c) => c.id));
  const aliases = (await getClientAliases(id)).filter((alias) =>
    activeClientIds.has(alias.client_id),
  );

  // Lean fetch for the client-side duplicate-preview heuristic -- only
  // the fields the match key needs (client_id + document_date +
  // total_amount), scoped to non-voided documents for this company.
  // The server-side check inside import_sales_row is the actual
  // enforcement; this is only a preview convenience (see spec Design
  // Notes).
  const supabase = await createClient();
  const { data: existingDocumentsData } = await supabase
    .from("sales_documents")
    .select("client_id, document_date, total_amount")
    .eq("company_id", id)
    .eq("voided", false);

  const existingDocuments = existingDocumentsData ?? [];

  return (
    <div className="mx-auto flex w-full max-w-[700px] flex-col gap-5">
      <PageHeader
        eyebrow="GESTIÓN / VENTAS"
        title="Importar ventas"
        subtitle={membership.company.name}
      />
      <ModeTabs companyId={id} mode={mode} />
      <Card padding="24px">
        <ImportSalesForm
          companyId={id}
          defaultCurrency={membership.company.currency}
          activeClients={activeClients}
          clientAliases={aliases.map((a) => ({
            externalName: a.external_name,
            clientId: a.client_id,
          }))}
          existingDocuments={existingDocuments}
        />
      </Card>
    </div>
  );
}
