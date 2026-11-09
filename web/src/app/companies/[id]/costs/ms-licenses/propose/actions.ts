"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export type ConfirmProposalState = { error: string | null };

/** The database's reason after its code ("EXISTS: Ese mes ya tiene..."), else a plain message. */
function reasonOf(message: string): string {
  const match = /^(NO_INVOICES|MIXED|EXISTS|NOT_POSITIVE): ([\s\S]*)$/.exec(message);
  return match ? match[2] : "No se pudo crear el reparto de ese mes.";
}

/**
 * Creates the month's MS licenses pool from its supplier invoices and splits
 * it (create_ms_license_pool_for_month, migration 20261108020000): the same
 * split the preview showed. One month at a time.
 */
export async function confirmMsLicensePool(
  companyId: string,
  period: string,
  _prev: ConfirmProposalState,
): Promise<ConfirmProposalState> {
  if (!/^\d{4}-\d{2}-01$/.test(period)) return { error: "Mes inválido." };

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("create_ms_license_pool_for_month", {
    p_company_id: companyId,
    p_period: period,
  });
  if (error || typeof data !== "string") {
    if (error) console.error(error);
    return { error: reasonOf(error?.message ?? "") };
  }

  revalidatePath(`/companies/${companyId}/costs/ms-licenses`);
  revalidatePath(`/companies/${companyId}/costs`);
  redirect(`/companies/${companyId}/costs/ms-licenses/${data}`);
}
