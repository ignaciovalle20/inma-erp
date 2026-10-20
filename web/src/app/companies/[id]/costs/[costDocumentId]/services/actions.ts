"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export type ServiceAllocationRowInput = {
  cost_period_id: string;
  amount: string;
};

export type SetServiceAllocationsState = {
  error: string | null;
  success: boolean;
  values: { rows: ServiceAllocationRowInput[] };
};

function parseRows(formData: FormData): ServiceAllocationRowInput[] {
  const periodIds = formData.getAll("cost_period_id");
  const amounts = formData.getAll("amount");
  const rows: ServiceAllocationRowInput[] = [];
  for (let i = 0; i < Math.max(periodIds.length, amounts.length); i++) {
    const periodId = periodIds[i];
    const amount = amounts[i];
    rows.push({
      cost_period_id: typeof periodId === "string" ? periodId : "",
      amount: typeof amount === "string" ? amount : "",
    });
  }
  return rows;
}

/**
 * Saves the purchase invoice's allocation to recurring service cost
 * periods (set_cost_service_allocations replaces the document's rows, all
 * confirmed: saving here also confirms a suggestion). An empty list clears
 * it, and the document goes back to "sin asignar".
 */
export async function setServiceAllocations(
  companyId: string,
  costDocumentId: string,
  _prevState: SetServiceAllocationsState,
  formData: FormData,
): Promise<SetServiceAllocationsState> {
  const rows = parseRows(formData);
  const values = { rows };

  for (const row of rows) {
    if (!row.cost_period_id) {
      return { error: "Cada fila necesita un servicio y período.", success: false, values };
    }
    const amount = Number(row.amount);
    if (row.amount.trim() === "" || !Number.isFinite(amount) || amount <= 0) {
      return { error: "Cada fila necesita un monto mayor que cero.", success: false, values };
    }
  }
  if (new Set(rows.map((row) => row.cost_period_id)).size !== rows.length) {
    return { error: "Hay un período repetido: sumá los montos en una sola fila.", success: false, values };
  }

  const supabase = await createClient();

  // Same app-level guard as "Dividir": the document is this company's and
  // a general cost (the database refuses anything else anyway).
  const { data: existing, error: existingError } = await supabase
    .from("cost_documents")
    .select("classification, project_id")
    .eq("id", costDocumentId)
    .eq("company_id", companyId)
    .maybeSingle();

  if (existingError) {
    console.error(existingError);
    return { error: "Algo salió mal. Intentá de nuevo.", success: false, values };
  }
  if (!existing) {
    return { error: "No tenés permiso para asignar este documento.", success: false, values };
  }
  if (existing.classification !== "general" || existing.project_id) {
    return { error: "Solo un costo general sin trabajo se asigna a servicios.", success: false, values };
  }

  const { error } = await supabase.rpc("set_cost_service_allocations", {
    p_cost_document_id: costDocumentId,
    p_allocations: rows.map((row) => ({
      cost_period_id: row.cost_period_id,
      amount: Number(row.amount),
      status: "confirmed",
    })),
  });

  if (error) {
    console.error(error);
    return { error: error.message ?? "Algo salió mal. Intentá de nuevo.", success: false, values };
  }

  revalidatePath(`/companies/${companyId}/costs`);
  revalidatePath(`/companies/${companyId}/costs/${costDocumentId}`);
  return { error: null, success: true, values };
}
