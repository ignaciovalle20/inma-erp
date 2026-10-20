"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCompanyForEdit } from "@/lib/dal";
import { suggestCostAllocations } from "@/lib/costAllocationSuggestionsLoader";

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * "Sugerir asignaciones" on the costs list: runs the purchase invoice ->
 * service rules (lib/costAllocationSuggestions.ts) over the month on
 * screen, or every month when the list shows the whole history. Never
 * touches an invoice that already has an allocation.
 */
export async function suggestCostServiceAllocations(companyId: string, month: string | null) {
  const membership = await getCompanyForEdit(companyId);
  if (!membership) redirect("/companies");

  const period = month && MONTH_PATTERN.test(month) ? month : null;
  const supabase = await createClient();
  const result = await suggestCostAllocations(supabase, companyId, { month: period });

  revalidatePath(`/companies/${companyId}/costs`);
  const query = result.error
    ? "sugerencias=error"
    : `confirmadas=${result.confirmed}&sugeridas=${result.suggested}`;
  redirect(`/companies/${companyId}/costs?period=${period ?? "all"}&${query}`);
}
