"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { suggestAllocations } from "@/lib/salesAllocations";

export type AllocationRowInput = {
  target_type: "period" | "quote";
  target_id: string;
  amount: string;
  status: "suggested" | "confirmed";
  notes: string;
};

export type SaveAllocationsResult = { error: string | null };

const GENERIC_ERROR = "Algo salió mal. Probá de nuevo.";

function revalidateAllocations(companyId: string, salesDocumentId: string) {
  revalidatePath(`/companies/${companyId}/sales/${salesDocumentId}/allocations`);
  revalidatePath(`/companies/${companyId}/sales/reconcile`);
  revalidatePath(`/companies/${companyId}/sales`);
  // Periods change state; jobs show billed vs. quoted.
  revalidatePath(`/companies/${companyId}/recurring-services`, "layout");
  revalidatePath(`/companies/${companyId}/projects`, "layout");
}

/** The database error a person can act on, in Spanish. */
function describe(message: string): string {
  if (message.includes("exceed")) return "Las asignaciones suman más que el neto de la factura.";
  if (message.includes("voided period")) return "Uno de los períodos está anulado.";
  if (message.includes("cannot be allocated")) return "Este documento no se puede asignar (nota de crédito o anulado).";
  if (message.includes("same company")) return "Uno de los destinos no es de esta empresa.";
  if (message.includes("duplicate key")) return "Hay un destino repetido.";
  return GENERIC_ERROR;
}

/**
 * Replaces every allocation of the document (set_sales_allocations, one
 * transaction). The total can't exceed the document's net -- checked here
 * for the message and again by the database.
 */
export async function saveSalesAllocations(
  companyId: string,
  salesDocumentId: string,
  rows: AllocationRowInput[],
): Promise<SaveAllocationsResult> {
  const supabase = await createClient();

  const { data: document, error: documentError } = await supabase
    .from("sales_documents")
    .select("id, net_amount, currency, document_type, voided, annulled_by_document_id")
    .eq("id", salesDocumentId)
    .eq("company_id", companyId)
    .maybeSingle();

  if (documentError) {
    console.error(documentError);
    return { error: GENERIC_ERROR };
  }
  if (!document) {
    return { error: "No se encontró este documento en la empresa." };
  }

  const seen = new Set<string>();
  let total = 0;
  for (const row of rows) {
    const amount = Number(row.amount);
    if (!row.target_id || !["period", "quote"].includes(row.target_type)) {
      return { error: "Cada fila necesita un destino." };
    }
    if (!row.amount.trim() || !Number.isFinite(amount) || amount <= 0) {
      return { error: "Cada fila necesita un monto mayor que cero." };
    }
    const key = `${row.target_type}:${row.target_id}`;
    if (seen.has(key)) return { error: "Hay un destino repetido." };
    seen.add(key);
    total += amount;
  }

  const tolerance = document.currency === "CLP" ? 0.5 : 0.005;
  if (total > Number(document.net_amount) + tolerance) {
    return { error: "Las asignaciones suman más que el neto de la factura." };
  }

  const { error } = await supabase.rpc("set_sales_allocations", {
    p_sales_document_id: salesDocumentId,
    p_allocations: rows.map((row) => ({
      target_type: row.target_type,
      target_id: row.target_id,
      amount: Number(row.amount),
      status: row.status === "suggested" ? "suggested" : "confirmed",
      notes: row.notes.trim() || null,
    })),
  });

  if (error) {
    console.error(error);
    return { error: describe(error.message ?? "") };
  }

  revalidateAllocations(companyId, salesDocumentId);
  return { error: null };
}

/** Looks for a single match by amount for this one document (see suggest_sales_allocations). */
export async function suggestForDocument(
  companyId: string,
  salesDocumentId: string,
): Promise<{ error: string | null; created: number }> {
  const supabase = await createClient();
  const result = await suggestAllocations(supabase, companyId, [salesDocumentId]);
  if (result.error) return { error: GENERIC_ERROR, created: 0 };
  revalidateAllocations(companyId, salesDocumentId);
  return { error: null, created: result.created };
}
