"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { describeTechnicianError } from "@/lib/technicians";
import { suggestTechnicianDocuments } from "@/lib/technicianDocumentSuggestions";

/**
 * The RUTs of a technician (Chile, technician_suppliers): each one is a
 * supplier whose facturas or boletas are recognized as the technician's. A
 * technician may have several; a supplier belongs to one technician at most.
 * Linking a RUT looks for suggestions right away (Conciliar).
 */

export type SupplierLinkResult = { error: string | null; suggestions: number };

function refresh(companyId: string, personnelId: string) {
  revalidatePath(`/companies/${companyId}/personnel/${personnelId}/edit`);
  revalidatePath(`/companies/${companyId}/personnel/${personnelId}/account`);
  revalidatePath(`/companies/${companyId}/sales/reconcile`);
  revalidatePath(`/companies/${companyId}/suppliers`);
}

async function lookForSuggestions(companyId: string, personnelId: string): Promise<number> {
  const supabase = await createClient();
  const result = await suggestTechnicianDocuments(supabase, companyId, { personnelId });
  if (result.error) console.error(result.error);
  return result.created;
}

/** "Agregar RUT": finds the supplier with that RUT (normalized) or creates it, and links it. */
export async function addTechnicianTaxId(
  companyId: string,
  personnelId: string,
  taxId: string,
  supplierName: string,
): Promise<SupplierLinkResult> {
  if (!taxId.trim()) return { error: "Ingresá un RUT.", suggestions: 0 };

  try {
    const supabase = await createClient();
    const { error } = await supabase.rpc("link_technician_tax_id", {
      p_personnel_id: personnelId,
      p_tax_id: taxId.trim(),
      p_supplier_name: supplierName.trim() || null,
    });
    if (error) {
      console.error(error);
      return { error: describeTechnicianError(error.message), suggestions: 0 };
    }
    const suggestions = await lookForSuggestions(companyId, personnelId);
    refresh(companyId, personnelId);
    return { error: null, suggestions };
  } catch (thrown) {
    console.error(thrown);
    return { error: thrown instanceof Error ? thrown.message : "No se pudo agregar el RUT.", suggestions: 0 };
  }
}

/** Links a supplier that already exists. */
export async function linkTechnicianSupplier(
  companyId: string,
  personnelId: string,
  supplierId: string,
): Promise<SupplierLinkResult> {
  if (!supplierId) return { error: "Elegí un proveedor.", suggestions: 0 };

  try {
    const supabase = await createClient();
    const { error } = await supabase
      .from("technician_suppliers")
      .insert({ company_id: companyId, personnel_id: personnelId, supplier_id: supplierId });
    if (error) {
      console.error(error);
      return { error: describeTechnicianError(error.message), suggestions: 0 };
    }
    const suggestions = await lookForSuggestions(companyId, personnelId);
    refresh(companyId, personnelId);
    return { error: null, suggestions };
  } catch (thrown) {
    console.error(thrown);
    return { error: thrown instanceof Error ? thrown.message : "No se pudo vincular el proveedor.", suggestions: 0 };
  }
}

/** Removes a RUT from the ficha (refused while documents of that supplier are linked to charges). */
export async function unlinkTechnicianSupplier(
  companyId: string,
  personnelId: string,
  linkId: string,
): Promise<{ error: string | null }> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("technician_suppliers")
      .delete()
      .eq("id", linkId)
      .eq("company_id", companyId)
      .eq("personnel_id", personnelId)
      .select("id");
    if (error) {
      console.error(error);
      return { error: describeTechnicianError(error.message) };
    }
    if (!data || data.length === 0) return { error: "No se encontró ese RUT en la ficha." };
  } catch (thrown) {
    console.error(thrown);
    return { error: thrown instanceof Error ? thrown.message : "No se pudo quitar el RUT." };
  }

  refresh(companyId, personnelId);
  return { error: null };
}
