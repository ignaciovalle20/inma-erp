import { redirect } from "next/navigation";
import { getSession, getCompanyForEdit, getClients } from "@/lib/dal";
import { createClient } from "@/lib/supabase/server";
import { ImportSalesForm } from "./form";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/Card";

export default async function ImportSalesPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
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

  const clients = await getClients(id);
  const activeClients = clients
    .filter((client) => client.active)
    .map((client) => ({ id: client.id, name: client.name }));

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
      <Card padding="24px">
        <ImportSalesForm
          companyId={id}
          defaultCurrency={membership.company.currency}
          activeClients={activeClients}
          existingDocuments={existingDocuments}
        />
      </Card>
    </div>
  );
}
