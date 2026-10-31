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
import { selectAll } from "@/lib/pagination";

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
    .map((supplier) => ({ id: supplier.id, name: supplier.name, tax_id: supplier.tax_id }));

  // Lean fetch for the client-side duplicate-preview heuristic, mirroring
  // the sales import's own -- the server-side check inside
  // import_cost_rows_batch is the actual enforcement.
  // Only documents that exist count (a deleted one can be imported again).
  const supabase = await createClient();
  const { data: existingDocumentsData, error: existingDocumentsError } = await selectAll(
    supabase
      .from("cost_documents")
      .select("supplier_id, document_date, total_amount, source_document_type, document_number")
      .eq("company_id", id),
  );
  if (existingDocumentsError) console.error(existingDocumentsError);

  const provisionalCosts = await getProvisionalCostDocuments(id);

  return (
    <div className="mx-auto flex w-full max-w-[760px] flex-col gap-5">
      <PageHeader
        eyebrow="GESTIÓN / COSTOS"
        title="Importar facturas de compra"
        subtitle={membership.company.name}
        back={{ href: `/companies/${id}/costs`, label: "Volver a Costos" }}
      />
      <Card padding="24px">
        <ImportCostsForm
          companyId={id}
          config={config}
          activeSuppliers={activeSuppliers}
          existingDocuments={existingDocumentsData ?? []}
          provisionalCosts={provisionalCosts}
        />
      </Card>
    </div>
  );
}
