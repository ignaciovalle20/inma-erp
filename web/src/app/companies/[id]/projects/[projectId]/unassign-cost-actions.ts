"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCompanyForEdit } from "@/lib/dal";
import { technicianChargeHref } from "@/lib/costDocumentDeletion";

export type UnassignCostResult = {
  error: string | null;
  /** Set when the expense is a technician's charge: it is fixed in Técnicos instead. */
  technicianChargeHref?: string | null;
};

/**
 * "Quitar del trabajo": unassign_cost_document_from_project removes only the
 * relation with this job. The document, its lines and receipts stay, in Costos,
 * ready to be assigned again. Every page of the company is revalidated: the
 * job's Costos / Margen, Costos and the reports all read the costs.
 */
export async function unassignCostFromProject(
  companyId: string,
  projectId: string,
  costDocumentId: string,
): Promise<UnassignCostResult> {
  const membership = await getCompanyForEdit(companyId);
  if (!membership) return { error: "No tenés acceso a esta empresa." };

  const supabase = await createClient();
  const { data: charge, error: chargeError } = await supabase
    .from("technician_charges")
    .select("id, project_id")
    .eq("company_id", companyId)
    .eq("cost_document_id", costDocumentId)
    .maybeSingle();
  if (chargeError) {
    console.error(chargeError);
    return { error: "Algo salió mal. Intentá de nuevo." };
  }
  if (charge) {
    return {
      error: "Este gasto es el cargo de un técnico (Mano de obra): corregilo o eliminalo desde la sección Técnicos del trabajo.",
      technicianChargeHref: technicianChargeHref(companyId, charge),
    };
  }

  const { error } = await supabase.rpc("unassign_cost_document_from_project", {
    p_cost_document_id: costDocumentId,
    p_project_id: projectId,
  });
  if (error) {
    console.error(error);
    return { error: error.message || "No se pudo quitar el gasto del trabajo." };
  }

  revalidatePath(`/companies/${companyId}`, "layout");
  return { error: null };
}
