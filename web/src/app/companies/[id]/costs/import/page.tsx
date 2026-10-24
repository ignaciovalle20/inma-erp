import { redirect } from "next/navigation";
import {
  getSession,
  getCompanyForEdit,
  getSuppliers,
  getProvisionalCostDocuments,
} from "@/lib/dal";
import { createClient } from "@/lib/supabase/server";
import { ImportCostsForm } from "./form";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/Card";
import { companyConfig } from "@/lib/companyConfig";

export default async function ImportCostsPage({
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

  // Every company imports; the currency rule comes from its configuration.
  const config = companyConfig(membership.company);

  const suppliers = await getSuppliers(id);
  const activeSuppliers = suppliers
    .filter((supplier) => supplier.active)
    .map((supplier) => ({ id: supplier.id, name: supplier.name }));

  // Lean fetch for the client-side duplicate-preview heuristic, mirroring
  // the sales import's own -- the server-side check inside
  // import_cost_rows_batch is the actual enforcement.
  const supabase = await createClient();
  const { data: existingDocumentsData } = await supabase
    .from("cost_documents")
    .select("supplier_id, document_date, total_amount")
    .eq("company_id", id);
  // Invoices whose imported document was deleted ("Eliminar"): skipped like a
  // duplicate unless "Importar igual" (import_cost_rows_batch, 20261024020000).
  const { data: deletedRowsData, error: deletedRowsError } = await supabase
    .from("cost_import_rows")
    .select("deleted_supplier_id, deleted_document_date, deleted_total_amount, cost_import_batches!inner(company_id)")
    .eq("cost_import_batches.company_id", id)
    .not("deleted_at", "is", null);
  if (deletedRowsError) console.error(deletedRowsError);
  const deletedDocuments = (deletedRowsData ?? []).map((row) => ({
    supplier_id: row.deleted_supplier_id as string | null,
    document_date: row.deleted_document_date as string,
    total_amount: Number(row.deleted_total_amount),
    deleted: true,
  }));

  const provisionalCosts = await getProvisionalCostDocuments(id);

  return (
    <div className="mx-auto flex w-full max-w-[760px] flex-col gap-5">
      <PageHeader
        eyebrow="GESTIÓN / COSTOS"
        title="Importar facturas de compra"
        subtitle={membership.company.name}
      />
      <Card padding="24px">
        <ImportCostsForm
          companyId={id}
          config={config}
          activeSuppliers={activeSuppliers}
          existingDocuments={[...(existingDocumentsData ?? []), ...deletedDocuments]}
          provisionalCosts={provisionalCosts}
        />
      </Card>
    </div>
  );
}
