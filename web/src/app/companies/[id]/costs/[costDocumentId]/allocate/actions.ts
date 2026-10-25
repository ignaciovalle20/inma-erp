"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import type { CostAllocationMethod, CostAllocationTargetType } from "@/lib/dal";
import { currencyDecimals } from "@/lib/currencies";

/**
 * A row's destination: a job, client or area (cost_allocations), or a
 * recurring service cost period (cost_service_allocations, target_id is
 * the cost period's id).
 */
export type AllocationTargetType = CostAllocationTargetType | "service";

export type AllocationRowInput = {
  target_type: AllocationTargetType | "";
  target_id: string;
  method: CostAllocationMethod;
  value: string;
};

export type SetCostAllocationsState = {
  error: string | null;
  success: boolean;
  values: {
    rows: AllocationRowInput[];
  };
};

const TARGET_TYPES: AllocationTargetType[] = [
  "project",
  "client",
  "business_area",
  "service",
];

const METHODS: CostAllocationMethod[] = ["percentage", "fixed_amount"];

function parseRows(formData: FormData): AllocationRowInput[] {
  const targetTypes = formData.getAll("target_type");
  const targetIds = formData.getAll("target_id");
  const methods = formData.getAll("method");
  const values = formData.getAll("value");
  const count = Math.max(
    targetTypes.length,
    targetIds.length,
    methods.length,
    values.length,
  );

  const rows: AllocationRowInput[] = [];
  for (let i = 0; i < count; i++) {
    const targetType = targetTypes[i];
    const targetId = targetIds[i];
    const method = methods[i];
    const value = values[i];
    rows.push({
      target_type:
        typeof targetType === "string" &&
        (TARGET_TYPES as string[]).includes(targetType)
          ? (targetType as AllocationTargetType)
          : "",
      target_id: typeof targetId === "string" ? targetId : "",
      method:
        typeof method === "string" && (METHODS as string[]).includes(method)
          ? (method as CostAllocationMethod)
          : "percentage",
      value: typeof value === "string" ? value : "",
    });
  }
  return rows;
}

export async function setCostAllocations(
  companyId: string,
  costDocumentId: string,
  _prevState: SetCostAllocationsState,
  formData: FormData,
): Promise<SetCostAllocationsState> {
  const rows = parseRows(formData);
  const values = { rows };

  if (rows.length < 2) {
    return {
      error: "Agregá al menos 2 destinos para asignar este costo.",
      success: false,
      values,
    };
  }

  for (const row of rows) {
    if (!row.target_type) {
      return {
        error: "Cada fila necesita un tipo de destino.",
        success: false,
        values,
      };
    }
    if (!row.target_id) {
      return {
        error: "Cada fila necesita un destino seleccionado.",
        success: false,
        values,
      };
    }
    if (row.value.trim() === "" || !Number.isFinite(Number(row.value))) {
      return {
        error: "Cada fila necesita un valor numérico.",
        success: false,
        values,
      };
    }
  }

  const supabase = await createClient();

  // App-level guard confirming the cost document belongs to this company
  // and is a general cost -- the RPC also refuses a direct cost (the
  // real guarantee against a tampered request), but checking first
  // avoids a confusing raw DB error for the normal UX path.
  const { data: existing, error: existingError } = await supabase
    .from("cost_documents")
    .select("classification, currency")
    .eq("id", costDocumentId)
    .eq("company_id", companyId)
    .maybeSingle();

  if (existingError) {
    console.error(existingError);
    return {
      error: "Algo salió mal. Intentá de nuevo.",
      success: false,
      values,
    };
  }

  if (!existing) {
    return {
      error: "No tenés permiso para asignar este documento.",
      success: false,
      values,
    };
  }

  if (existing.classification !== "general") {
    return {
      error: "Solo los costos generales se pueden asignar.",
      success: false,
      values,
    };
  }

  // The form saves whole minor units (pesos for CLP); anything finer would
  // leave cents the document's currency doesn't have.
  const unit = 10 ** currencyDecimals(existing.currency);
  const minor = (value: string) => Number(value) * unit;
  if (
    rows.some(
      (row) => row.method === "fixed_amount" && Math.abs(minor(row.value) - Math.round(minor(row.value))) > 1e-6,
    )
  ) {
    return {
      error:
        currencyDecimals(existing.currency) === 0
          ? `Los importes en ${existing.currency} van sin decimales.`
          : `Los importes en ${existing.currency} van con hasta 2 decimales.`,
      success: false,
      values,
    };
  }

  const servicePeriodIds = rows.filter((row) => row.target_type === "service").map((row) => row.target_id);
  if (new Set(servicePeriodIds).size !== servicePeriodIds.length) {
    return {
      error: "Hay un servicio y período repetido: sumá los importes en una sola fila.",
      success: false,
      values,
    };
  }

  // Both parts in one save (set_cost_document_allocations): services and
  // jobs/clients/areas together add up to the total. position keeps the
  // form's row order across both tables.
  const { error } = await supabase.rpc("set_cost_document_allocations", {
    p_cost_document_id: costDocumentId,
    p_allocations: rows.flatMap((row, position) =>
      row.target_type === "service"
        ? []
        : [{ target_type: row.target_type, target_id: row.target_id, method: row.method, value: Number(row.value), position }],
    ),
    p_service_allocations: rows.flatMap((row, position) =>
      row.target_type === "service"
        ? [{ cost_period_id: row.target_id, gross_amount: Number(row.value), position }]
        : [],
    ),
  });

  if (error) {
    console.error(error);
    return {
      error: error.message ?? "Algo salió mal. Intentá de nuevo.",
      success: false,
      values,
    };
  }

  revalidatePath(`/companies/${companyId}/costs`);
  revalidatePath(`/companies/${companyId}/costs/${costDocumentId}`);

  // Stay on the page rather than redirecting -- matches the RPC's own
  // atomicity and lets the user see the saved state / keep adjusting.
  return { error: null, success: true, values };
}
