"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { suggestAllocations } from "@/lib/salesAllocations";
import { suggestCostAllocations } from "@/lib/costAllocationSuggestionsLoader";
import { suggestTechnicianDocuments } from "@/lib/technicianDocumentSuggestions";
import { describeTechnicianError } from "@/lib/technicians";

function revalidateReconcile(companyId: string) {
  revalidatePath(`/companies/${companyId}/sales/reconcile`);
  revalidatePath(`/companies/${companyId}/recurring-services`, "layout");
  revalidatePath(`/companies/${companyId}/projects`, "layout");
}

/**
 * "Buscar sugerencias": the automatic suggestions for the unallocated
 * documents of the month on screen (the monthly close) -- or of every
 * month when the page shows them all. Scoped to the month so one click
 * never floods Conciliar with suggestions for the whole history (the
 * rehearsal with prod data: 45 at once, many on months long closed).
 */
export async function suggestAllAllocations(
  companyId: string,
  month: string | null,
): Promise<{ error: string | null; created: number }> {
  const validMonth = month && /^\d{4}-(0[1-9]|1[0-2])$/.test(month) ? month : null;
  const supabase = await createClient();
  const result = await suggestAllocations(supabase, companyId, null, validMonth);
  if (result.error) return { error: "No se pudieron buscar sugerencias. Probá de nuevo.", created: 0 };
  // The purchase invoices of the same month -> recurring service costs.
  const costs = await suggestCostAllocations(supabase, companyId, { month: validMonth });
  if (costs.error) console.error(costs.error);
  // Chile: the facturas / boletas of technicians -> their pending charges.
  const technicians = await suggestTechnicianDocuments(supabase, companyId, { month: validMonth });
  if (technicians.error) console.error(technicians.error);
  revalidateReconcile(companyId);
  return { error: null, created: result.created + costs.confirmed + costs.suggested + technicians.created };
}

/**
 * "Documentos de técnicos sugeridos": confirming links each document to its
 * suggested charges (link_technician_document, which also replaces an
 * assignment the document had when `replaceAllocations`, after the screen
 * asked); discarding keeps the document from being suggested again.
 */
export async function resolveTechnicianSuggestions(
  companyId: string,
  costDocumentIds: string[],
  decision: "confirm" | "discard",
  replaceAllocations: boolean,
): Promise<{ error: string | null; count: number }> {
  if (costDocumentIds.length === 0) return { error: null, count: 0 };
  const supabase = await createClient();

  if (decision === "discard") {
    const { data, error } = await supabase
      .from("technician_document_suggestions")
      .update({ status: "dismissed" })
      .eq("company_id", companyId)
      .eq("status", "pending")
      .in("cost_document_id", costDocumentIds)
      .select("id");
    if (error) {
      console.error(error);
      return { error: "No se pudieron descartar las sugerencias. Probá de nuevo.", count: 0 };
    }
    revalidateReconcile(companyId);
    return { error: null, count: data?.length ?? 0 };
  }

  const { data: suggestions, error: readError } = await supabase
    .from("technician_document_suggestions")
    .select("cost_document_id, charge_ids")
    .eq("company_id", companyId)
    .eq("status", "pending")
    .in("cost_document_id", costDocumentIds);
  if (readError) {
    console.error(readError);
    return { error: "No se pudieron leer las sugerencias. Probá de nuevo.", count: 0 };
  }

  let count = 0;
  const failures: string[] = [];
  for (const suggestion of suggestions ?? []) {
    const { error } = await supabase.rpc("link_technician_document", {
      p_cost_document_id: suggestion.cost_document_id,
      p_charge_ids: suggestion.charge_ids,
      p_replace_allocations: replaceAllocations,
    });
    if (error) {
      console.error(error);
      failures.push(describeTechnicianError(error.message));
      continue;
    }
    count += 1;
  }

  revalidateReconcile(companyId);
  revalidatePath(`/companies/${companyId}/costs`, "layout");
  revalidatePath(`/companies/${companyId}/personnel`, "layout");
  return {
    error: failures.length > 0 ? `${failures.length} sin vincular: ${failures.join(" · ")}` : null,
    count,
  };
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

/**
 * Purchase invoices suggested to recurring service cost periods
 * (cost_service_allocations): confirms them as they are, or discards them
 * (the invoice goes back to "sin asignar"; the database checks the
 * confirmed sum never exceeds the invoice's net).
 */
export async function resolveCostSuggestions(
  companyId: string,
  costDocumentIds: string[],
  decision: "confirm" | "discard",
): Promise<{ error: string | null; count: number }> {
  if (costDocumentIds.length === 0) return { error: null, count: 0 };

  const supabase = await createClient();
  const base = supabase.from("cost_service_allocations");
  const { data, error } =
    decision === "confirm"
      ? await base
          .update({ status: "confirmed" })
          .eq("company_id", companyId)
          .eq("status", "suggested")
          .in("cost_document_id", costDocumentIds)
          .select("id")
      : await base
          .delete()
          .eq("company_id", companyId)
          .eq("status", "suggested")
          .in("cost_document_id", costDocumentIds)
          .select("id");

  if (error) {
    console.error(error);
    return {
      error:
        decision === "confirm"
          ? `No se pudieron confirmar: ${error.message}`
          : "No se pudieron descartar las sugerencias. Probá de nuevo.",
      count: 0,
    };
  }

  revalidateReconcile(companyId);
  revalidatePath(`/companies/${companyId}/costs`, "layout");
  return { error: null, count: data?.length ?? 0 };
}
