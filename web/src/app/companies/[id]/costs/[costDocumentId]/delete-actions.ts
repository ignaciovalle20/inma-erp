"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCompanyForEdit } from "@/lib/dal";
import { safeRedirect, technicianChargeHref } from "@/lib/costDocumentDeletion";

export type DeleteCostResult = {
  error: string | null;
  /** Set when the expense is a technician's charge: it is fixed in Técnicos instead. */
  technicianChargeHref?: string | null;
};

/**
 * "Eliminar" on an expense: delete_cost_document (20261024020000) removes the
 * document with its lines, allocations to jobs and to recurring services and
 * its attachment rows in one transaction (and marks its import row, if any,
 * so the next import doesn't bring it back). Then its receipts are removed
 * from Storage -- after the database, so a failed removal only leaves an
 * orphan file, never an expense pointing to a missing one. Every page of the
 * company is revalidated: the job's Costos / Margen, Costos, the reports and
 * the services all read the costs. `redirectTo` (the document's own page)
 * goes back to where it was opened from; the lists just lose the row.
 */
export async function deleteCostDocument(
  companyId: string,
  costDocumentId: string,
  redirectTo: string | null = null,
): Promise<DeleteCostResult> {
  const membership = await getCompanyForEdit(companyId);
  if (!membership) return { error: "No tenés acceso a esta empresa." };

  const supabase = await createClient();
  const [{ data: document, error: documentError }, { data: charge, error: chargeError }] = await Promise.all([
    supabase.from("cost_documents").select("id").eq("id", costDocumentId).eq("company_id", companyId).maybeSingle(),
    supabase
      .from("technician_charges")
      .select("id, project_id")
      .eq("company_id", companyId)
      .eq("cost_document_id", costDocumentId)
      .maybeSingle(),
  ]);
  if (documentError || chargeError) {
    console.error(documentError ?? chargeError);
    return { error: "Algo salió mal. Intentá de nuevo." };
  }
  if (!document) return { error: "No se encontró el gasto." };
  if (charge) {
    return {
      error: "Este gasto es el cargo de un técnico (Mano de obra): corregilo o eliminalo desde la sección Técnicos del trabajo.",
      technicianChargeHref: technicianChargeHref(companyId, charge),
    };
  }

  const { data, error } = await supabase.rpc("delete_cost_document", { p_cost_document_id: costDocumentId });
  if (error) {
    console.error(error);
    return { error: error.message || "No se pudo eliminar el gasto." };
  }

  const paths = ((data as { attachments?: string[] } | null)?.attachments ?? []).filter(Boolean);
  if (paths.length > 0) {
    const { error: storageError } = await supabase.storage.from("cost-receipts").remove(paths);
    if (storageError) console.error("delete_cost_document: receipts left in Storage", paths, storageError);
  }

  revalidatePath(`/companies/${companyId}`, "layout");
  const target = safeRedirect(companyId, redirectTo);
  if (target) redirect(target);
  return { error: null };
}
