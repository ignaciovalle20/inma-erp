import { redirect } from "next/navigation";
import { getSession, getCompanyForEdit, getClients, getClientAliases } from "@/lib/dal";
import { createClient } from "@/lib/supabase/server";
import Link from "next/link";
import { ImportSalesForm } from "./form";
import { NuboxImportForm } from "./nubox/form";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/Card";
import { companyConfig, type SalesImportFormat } from "@/lib/companyConfig";

const FORMAT_LABEL: Record<SalesImportFormat, string> = {
  nubox: "Nubox",
  generic: "CSV / Excel (con mapeo)",
};

/** One tab per importer the company's configuration offers (lib/companyConfig.ts). */
function ModeTabs({
  companyId,
  mode,
  formats,
}: {
  companyId: string;
  mode: SalesImportFormat;
  formats: SalesImportFormat[];
}) {
  if (formats.length < 2) return null;

  const base = `/companies/${companyId}/sales/import`;
  const tab = (active: boolean) =>
    `rounded-md px-3 py-1.5 text-[13px] no-underline ${
      active
        ? "bg-[var(--color-surface)] font-semibold text-[var(--color-ink)] shadow-sm"
        : "text-[var(--color-muted)] hover:text-[var(--color-ink)]"
    }`;

  return (
    <div className="inline-flex gap-1 self-start rounded-lg bg-[var(--color-row)] p-1">
      {formats.map((format) => (
        <Link
          key={format}
          href={`${base}?modo=${format === "generic" ? "csv" : format}`}
          className={tab(mode === format)}
        >
          {FORMAT_LABEL[format]}
        </Link>
      ))}
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
  const user = await getSession();

  if (!user) {
    redirect("/login");
  }

  const membership = await getCompanyForEdit(id);

  if (!membership) {
    redirect("/companies");
  }

  // Every company imports; which importers it offers comes from its
  // configuration (Nubox is a Chilean invoicing system; the generic one,
  // with column mapping, works for any file).
  const config = companyConfig(membership.company);
  const formats = config.salesImportFormats;
  const requested: SalesImportFormat | null = modo === "csv" ? "generic" : modo === "nubox" ? "nubox" : null;
  const mode: SalesImportFormat = requested && formats.includes(requested) ? requested : formats[0];

  if (mode === "nubox") {
    return (
      <div className="mx-auto flex w-full max-w-[1000px] flex-col gap-5">
        <PageHeader
          eyebrow="GESTIÓN / VENTAS"
          title="Importar ventas"
          subtitle={membership.company.name}
          back={{ href: `/companies/${id}/sales`, label: "Volver a Ventas" }}
        />
        <ModeTabs companyId={id} mode={mode} formats={formats} />
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
  const [{ data: existingDocumentsData }, { data: existingFoliosData }] = await Promise.all([
    supabase
      .from("sales_documents")
      .select("client_id, document_date, total_amount")
      .eq("company_id", id)
      .eq("voided", false),
    supabase
      .from("sales_documents")
      .select("document_number")
      .eq("company_id", id)
      .eq("document_type", "invoice")
      .not("document_number", "is", null),
  ]);

  const existingDocuments = existingDocumentsData ?? [];
  const existingFolios = (existingFoliosData ?? [])
    .map((row) => row.document_number as string | null)
    .filter((folio): folio is string => Boolean(folio));

  return (
    <div className="mx-auto flex w-full max-w-[700px] flex-col gap-5">
      <PageHeader
        eyebrow="GESTIÓN / VENTAS"
        title="Importar ventas"
        subtitle={membership.company.name}
        back={{ href: `/companies/${id}/sales`, label: "Volver a Ventas" }}
      />
      <ModeTabs companyId={id} mode={mode} formats={formats} />
      <Card padding="24px">
        <ImportSalesForm
          companyId={id}
          config={config}
          existingFolios={existingFolios}
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
