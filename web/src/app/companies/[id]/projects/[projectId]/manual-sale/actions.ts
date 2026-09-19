"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCompanyForEdit } from "@/lib/dal";

export type ManualSaleState = {
  error: string | null;
  values: {
    document_date: string;
    net_amount: string;
    tax_amount: string;
    description: string;
  };
};

/**
 * "Registrar venta sin factura" (docs/cambios-flujo-v2.md 4.2): some
 * clients do not ask for an invoice, so the sale is recorded here, by hand,
 * with cobro 'pendiente' until it is marked paid. Client and area come from
 * the job (create_manual_sale_without_invoice), never from the form.
 */
export async function createManualSale(
  companyId: string,
  projectId: string,
  _prevState: ManualSaleState,
  formData: FormData,
): Promise<ManualSaleState> {
  const text = (name: string) => {
    const value = formData.get(name);
    return typeof value === "string" ? value : "";
  };

  const values = {
    document_date: text("document_date"),
    net_amount: text("net_amount"),
    tax_amount: text("tax_amount"),
    description: text("description"),
  };

  const net = Number(values.net_amount);
  const tax = values.tax_amount.trim() === "" ? 0 : Number(values.tax_amount);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(values.document_date)) {
    return { error: "La fecha de la venta es obligatoria.", values };
  }
  if (values.net_amount.trim() === "" || !Number.isFinite(net) || net <= 0) {
    return { error: "El monto neto debe ser mayor a cero.", values };
  }
  if (!Number.isFinite(tax) || tax < 0) {
    return { error: "El IVA no puede ser negativo.", values };
  }

  try {
    const membership = await getCompanyForEdit(companyId);
    if (!membership) {
      return { error: "No tenés acceso a esta empresa.", values };
    }

    const supabase = await createClient();
    const { error } = await supabase.rpc("create_manual_sale_without_invoice", {
      p_company_id: companyId,
      p_project_id: projectId,
      p_document_date: values.document_date,
      p_net_amount: net,
      p_tax_amount: tax,
      p_description: values.description.trim() || null,
    });

    if (error) {
      console.error(error);
      return { error: error.message, values };
    }
  } catch (thrown) {
    console.error(thrown);
    return {
      error: thrown instanceof Error ? thrown.message : "No se pudo registrar la venta.",
      values,
    };
  }

  revalidatePath(`/companies/${companyId}/sales`);
  revalidatePath(`/companies/${companyId}/sales/pending`);
  redirect(`/companies/${companyId}/projects/${projectId}`);
}
