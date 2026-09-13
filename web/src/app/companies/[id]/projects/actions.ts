"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

/**
 * Confirms "no cost for this project this month" via the
 * confirm_project_cost_zero RPC, which rejects when cost_documents
 * already exist for that project+period (the real guarantee -- see
 * migration 20260913040000). Bound as a plain <form action> from the
 * projects list, so it takes no FormData and returns void; errors are
 * logged server-side (the RPC's own rejection is the primary guardrail
 * -- the UI only ever offers this action on pending rows in the first
 * place). Revalidates the projects page so the status column reflects
 * the change without a client-side refetch.
 */
export async function confirmProjectCostZero(
  companyId: string,
  projectId: string,
  period: string,
): Promise<void> {
  const supabase = await createClient();

  const { error } = await supabase.rpc("confirm_project_cost_zero", {
    p_project_id: projectId,
    p_period: period,
  });

  if (error) {
    console.error(error);
    return;
  }

  revalidatePath(`/companies/${companyId}/projects`);
}

/**
 * Removes an existing confirmation -- a plain DELETE via RLS (no RPC
 * needed, per spec: there's no invariant to protect beyond company
 * membership). This is a distinct explicit action, never a side effect
 * of something else.
 */
export async function removeProjectCostConfirmation(
  companyId: string,
  projectId: string,
  period: string,
): Promise<void> {
  const supabase = await createClient();

  const { error } = await supabase
    .from("project_cost_confirmations")
    .delete()
    .eq("project_id", projectId)
    .eq("period", period);

  if (error) {
    console.error(error);
    return;
  }

  revalidatePath(`/companies/${companyId}/projects`);
}
