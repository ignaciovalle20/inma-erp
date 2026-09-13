import { redirect } from "next/navigation";
import { getSession, getCompanyForEdit, getClients } from "@/lib/dal";
import { createClient } from "@/lib/supabase/server";
import { ImportSalesForm } from "./form";

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
    <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-6 px-4 py-10">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-black dark:text-zinc-50">
          Import sales
        </h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-500">
          {membership.company.name}
        </p>
      </div>
      <ImportSalesForm
        companyId={id}
        defaultCurrency={membership.company.currency}
        activeClients={activeClients}
        existingDocuments={existingDocuments}
      />
    </div>
  );
}
