"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import type { ProjectStatus } from "@/lib/dal";
import { PROJECT_STATUSES } from "@/lib/projectStatus";

/**
 * Moves a job to a new kanban column. Bound with companyId and invoked
 * from ProjectStatusSelect (a plain function call wrapped in
 * useTransition, not a <form action> -- the card needs to auto-submit
 * on <select> change). hold_reason is required app-side when the new
 * status is en_espera and cleared for every other status -- there's no
 * DB constraint for this (see migration 20260918010000), same
 * "friendly check, not a DB invariant" choice already used elsewhere in
 * this file's siblings (validateProjectRefs).
 */
export async function updateProjectStatus(
  companyId: string,
  formData: FormData,
): Promise<void> {
  const projectId = formData.get("project_id");
  const status = formData.get("status");
  const holdReason = formData.get("hold_reason");

  if (typeof projectId !== "string" || !projectId) {
    return;
  }

  if (typeof status !== "string" || !PROJECT_STATUSES.includes(status as ProjectStatus)) {
    console.error(`updateProjectStatus: invalid status "${String(status)}"`);
    return;
  }

  const trimmedHoldReason =
    typeof holdReason === "string" && holdReason.trim() ? holdReason.trim() : null;

  if (status === "en_espera" && !trimmedHoldReason) {
    console.error("updateProjectStatus: en_espera requires a hold_reason");
    return;
  }

  const supabase = await createClient();

  // Relies on RLS (any-member UPDATE policy scoped to company_id) to
  // reject non-members -- same as the edit form's updateProject.
  const { error } = await supabase
    .from("projects")
    .update({
      status,
      hold_reason: status === "en_espera" ? trimmedHoldReason : null,
    })
    .eq("id", projectId)
    .eq("company_id", companyId);

  if (error) {
    console.error(error);
    return;
  }

  revalidatePath(`/companies/${companyId}/projects/board`);
  revalidatePath(`/companies/${companyId}/projects`);
}
