"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { describeTechnicianError, linkErrorCode, type LinkErrorCode } from "@/lib/technicians";
import { suggestTechnicianDocuments } from "@/lib/technicianDocumentSuggestions";

/**
 * Charge <-> purchase document (Chile, 20261026010000): the factura or boleta
 * of a technician becomes the cost of the charges it covers
 * (link_technician_document), or stops being it (unlink_technician_document).
 * Both RPCs do every check and move every peso; these actions only pass what
 * the screen chose and bring back what to say.
 */

export type LinkResult = {
  error: string | null;
  /** Why the database refused, for the screen to react (ALLOCATED asks to confirm). */
  code: LinkErrorCode | null;
  linked: boolean;
};

function refresh(companyId: string, costDocumentId: string) {
  revalidatePath(`/companies/${companyId}/costs`, "layout");
  revalidatePath(`/companies/${companyId}/costs/${costDocumentId}`);
  revalidatePath(`/companies/${companyId}/projects`, "layout");
  revalidatePath(`/companies/${companyId}/personnel`, "layout");
  revalidatePath(`/companies/${companyId}/sales/reconcile`);
}

export async function linkTechnicianDocument(
  companyId: string,
  costDocumentId: string,
  chargeIds: string[],
  replaceAllocations: boolean,
): Promise<LinkResult> {
  if (chargeIds.length === 0) return { error: "Elegí al menos un cargo.", code: "CHARGES", linked: false };

  try {
    const supabase = await createClient();
    const { error } = await supabase.rpc("link_technician_document", {
      p_cost_document_id: costDocumentId,
      p_charge_ids: chargeIds,
      p_replace_allocations: replaceAllocations,
    });
    if (error) {
      console.error(error);
      return { error: describeTechnicianError(error.message), code: linkErrorCode(error.message), linked: false };
    }
  } catch (thrown) {
    console.error(thrown);
    return {
      error: thrown instanceof Error ? thrown.message : "No se pudo vincular el documento.",
      code: null,
      linked: false,
    };
  }

  refresh(companyId, costDocumentId);
  return { error: null, code: null, linked: true };
}

export async function unlinkTechnicianDocument(
  companyId: string,
  costDocumentId: string,
): Promise<{ error: string | null }> {
  try {
    const supabase = await createClient();
    const { error } = await supabase.rpc("unlink_technician_document", { p_cost_document_id: costDocumentId });
    if (error) {
      console.error(error);
      return { error: describeTechnicianError(error.message) };
    }
  } catch (thrown) {
    console.error(thrown);
    return { error: thrown instanceof Error ? thrown.message : "No se pudo desvincular el documento." };
  }

  refresh(companyId, costDocumentId);
  return { error: null };
}

/**
 * "¿De qué técnico es?": the document's supplier (its RUT) joins a
 * technician's ficha, so this and every other document of that supplier is
 * recognized as theirs. Then the suggestions of that technician are looked
 * for, like when a RUT is added from the ficha.
 */
export async function assignSupplierToTechnician(
  companyId: string,
  costDocumentId: string,
  supplierId: string,
  personnelId: string,
): Promise<{ error: string | null }> {
  if (!personnelId) return { error: "Elegí el técnico." };

  try {
    const supabase = await createClient();
    const { error } = await supabase
      .from("technician_suppliers")
      .insert({ company_id: companyId, personnel_id: personnelId, supplier_id: supplierId });
    if (error) {
      console.error(error);
      return { error: describeTechnicianError(error.message) };
    }
    const suggestions = await suggestTechnicianDocuments(supabase, companyId, { personnelId });
    if (suggestions.error) console.error(suggestions.error);
  } catch (thrown) {
    console.error(thrown);
    return { error: thrown instanceof Error ? thrown.message : "No se pudo vincular el proveedor al técnico." };
  }

  refresh(companyId, costDocumentId);
  return { error: null };
}
