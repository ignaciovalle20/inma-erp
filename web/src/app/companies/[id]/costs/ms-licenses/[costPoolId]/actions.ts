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

  revalidatePath(`/companies/${companyId}/costs/ms-licenses/${costPoolId}`);
  return { error: null };
}

/**
 * Splits an already split pool again (reallocate_recurring_service_cost_pool,
 * migration 20261108010000): its shares are deleted and the invoice is split
 * among every cycle of its month, the ones created after the first split
 * included (audit 2026-11, M-01).
 */
export async function reallocateCostPool(
  companyId: string,
  costPoolId: string,
): Promise<AllocateCostPoolResult> {
  const supabase = await createClient();

  const { error } = await supabase.rpc("reallocate_recurring_service_cost_pool", {
    p_cost_pool_id: costPoolId,
  });

  if (error) {
    console.error(error);
    return { error: "No se pudo volver a repartir: no hay ciclos del mes para repartir o no tenés acceso a este reparto." };
  }

  revalidatePath(`/companies/${companyId}/costs/ms-licenses/${costPoolId}`);
  revalidatePath(`/companies/${companyId}/costs/ms-licenses`);
  return { error: null };
}
