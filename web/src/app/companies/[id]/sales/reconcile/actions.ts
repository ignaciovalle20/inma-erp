"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { suggestAllocations } from "@/lib/salesAllocations";

function revalidateReconcile(companyId: string) {
  revalidatePath(`/companies/${companyId}/sales/reconcile`);
  revalidatePath(`/companies/${companyId}/recurring-services`, "layout");
  revalidatePath(`/companies/${companyId}/projects`, "layout");
}

/** "Buscar sugerencias": the automatic match by net amount, every unallocated document of the company. */
export async function suggestAllAllocations(
  companyId: string,
): Promise<{ error: string | null; created: number }> {
  const supabase = await createClient();
  const result = await suggestAllocations(supabase, companyId, null);
  if (result.error) return { error: "No se pudieron buscar sugerencias. Probá de nuevo.", created: 0 };
  revalidateReconcile(companyId);
  return { error: null, created: result.created };
}

/** Confirms every suggested allocation of the given documents as they are. */
export async function confirmSuggestedAllocations(
  companyId: string,
  salesDocumentIds: string[],
): Promise<{ error: string | null; confirmed: number }> {
  if (salesDocumentIds.length === 0) return { error: null, confirmed: 0 };

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("sales_allocations")
    .update({ status: "confirmed" })
    .eq("company_id", companyId)
    .eq("status", "suggested")
    .in("sales_document_id", salesDocumentIds)
    .select("id");

  if (error) {
    console.error(error);
    return { error: "No se pudieron confirmar las sugerencias. Probá de nuevo.", confirmed: 0 };
  }

  revalidateReconcile(companyId);
  revalidatePath(`/companies/${companyId}/sales`);
  return { error: null, confirmed: data?.length ?? 0 };
}
