"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export type AllocateCostPoolResult = { error: string | null };

/**
 * Calls the allocate_recurring_service_cost_pool RPC (see migration
 * 20260922050000) -- the RPC itself is the real enforcement point for
 * "already allocated" / "nothing to split across", this just
 * translates a failure into a friendly message.
 */
export async function allocateCostPool(
  companyId: string,
  costPoolId: string,
): Promise<AllocateCostPoolResult> {
  const supabase = await createClient();

  const { error } = await supabase.rpc("allocate_recurring_service_cost_pool", {
    p_cost_pool_id: costPoolId,
  });

  if (error) {
    console.error(error);
    return {
      error:
        "Could not allocate this cost pool. It may already be allocated, or there are no matching occurrences for this period to split it across.",
    };
  }

  revalidatePath(`/companies/${companyId}/recurring-services/cost-pools/${costPoolId}`);
  return { error: null };
}
