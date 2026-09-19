"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import type { ProjectStatus } from "@/lib/dal";
import { PROJECT_STATUSES } from "@/lib/projectStatus";

export type UpdateProjectStatusResult = { error: string | null };

/**
 * Moves a job to a new kanban column. Bound with companyId and invoked
 * from ProjectStatusSelect (a plain function call wrapped in
 * useTransition, not a <form action> -- the card needs to auto-submit
 * on <select> change). hold_reason is required app-side when the new
 * status is en_espera and cleared for every other status -- there's no
 * DB constraint for this (see migration 20260918010000), same
 * "friendly check, not a DB invariant" choice already used elsewhere in
 * this file's siblings (validateProjectRefs).
 *
 * Returns the real failure message (never throws, never fails silently)
 * so the card can show it and roll back to the previous status.
 */
export async function updateProjectStatus(
  companyId: string,
  formData: FormData,
): Promise<UpdateProjectStatusResult> {
  const projectId = formData.get("project_id");
  const status = formData.get("status");
  const holdReason = formData.get("hold_reason");

  if (typeof projectId !== "string" || !projectId) {
    return { error: "Falta el trabajo a actualizar." };
  }

  if (typeof status !== "string" || !PROJECT_STATUSES.includes(status as ProjectStatus)) {
    return { error: `Estado inválido: "${String(status)}".` };
  }

  const trimmedHoldReason =
    typeof holdReason === "string" && holdReason.trim() ? holdReason.trim() : null;

  if (status === "en_espera" && !trimmedHoldReason) {
    return { error: "El estado \"En espera\" necesita un motivo." };
  }

  const supabase = await createClient();

  // Relies on RLS (any-member UPDATE policy scoped to company_id) to
  // reject non-members -- same as the edit form's updateProject. A
  // non-member's update matches zero rows rather than erroring, hence
  // the .select() check below.
  const { data, error } = await supabase
    .from("projects")
    .update({
      status,
      hold_reason: status === "en_espera" ? trimmedHoldReason : null,
    })
    .eq("id", projectId)
    .eq("company_id", companyId)
    .select("id");

  if (error) {
    console.error(error);
    return { error: error.message };
  }

  if (!data || data.length === 0) {
    return { error: "No se encontró el trabajo o no tenés permiso para modificarlo." };
  }

  revalidatePath(`/companies/${companyId}/projects/board`);
  revalidatePath(`/companies/${companyId}/projects`);

  return { error: null };
}
