"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export type GenerateRecurringServiceEntryResult = {
  error: string | null;
};

/**
 * Calls the generate_recurring_service_entry RPC for "this period" --
 * per spec Decisions, a single one-click action for the current period
 * only (no bulk backfill). p_period is the first-of-period date the
 * client computed at click time; the RPC re-normalizes and is the real
 * enforcement point for idempotency/validity (see migration
 * 20260913070000).
 */
export async function generateRecurringServiceEntry(
  companyId: string,
  recurringServiceId: string,
  period: string,
): Promise<GenerateRecurringServiceEntryResult> {
  const supabase = await createClient();

  const { error } = await supabase.rpc("generate_recurring_service_entry", {
    p_recurring_service_id: recurringServiceId,
    p_period: period,
  });

  if (error) {
    console.error(error);
    return {
      error:
        "Could not generate this period. It may already be generated, or the service is outside its validity.",
    };
  }

  revalidatePath(`/companies/${companyId}/recurring-services`);

  return { error: null };
}
