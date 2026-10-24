import "server-only";

import { createClient } from "@/lib/supabase/server";
import { getSession } from "@/lib/dal";
import { getCostPeriods, getCostServiceAllocations } from "@/lib/costServiceAllocations";
import { formatDisplayDate } from "@/lib/paymentStatus";
import { monthLabel } from "@/lib/period";
import type { DeletionBlocker } from "@/lib/recurringServiceDeletion";

type Embedded<T> = T | T[] | null;

function firstOf<T>(value: Embedded<T> | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

const STATUS = { suggested: "sugerida", confirmed: "confirmada" } as Record<string, string>;

/**
 * Everything that keeps the service from being deleted, read with the
 * caller's session (RLS) -- the same checks delete_recurring_service runs.
 * `failed` when a read failed: the button stays off rather than guessing.
 */
export async function getServiceDeletionBlockers(
  companyId: string,
  serviceId: string,
): Promise<{ blockers: DeletionBlocker[]; cycles: number; costPeriods: number; failed: boolean }> {
  const user = await getSession();
  if (!user) return { blockers: [], cycles: 0, costPeriods: 0, failed: true };

  const supabase = await createClient();
  const { data: cycles, error: cyclesError } = await supabase
    .from("recurring_service_occurrences")
    .select("id, period, sales_document_id, sales_documents(document_number)")
    .eq("recurring_service_id", serviceId);
  const { data: legacy, error: legacyError } = await supabase
    .from("sales_documents")
    .select("id, document_number, document_date")
    .eq("company_id", companyId)
    .eq("recurring_service_id", serviceId);
  if (cyclesError || legacyError) {
    console.error(cyclesError ?? legacyError);
    return { blockers: [], cycles: 0, costPeriods: 0, failed: true };
  }

  type CycleRow = { id: string; period: string; sales_document_id: string | null; sales_documents: Embedded<{ document_number: string | null }> };
  const cycleRows = (cycles ?? []) as CycleRow[];
  const cycleIds = cycleRows.map((cycle) => cycle.id);
  const periodOf = new Map(cycleRows.map((cycle) => [cycle.id, monthLabel(cycle.period.slice(0, 7))]));

  const none = ["00000000-0000-0000-0000-000000000000"];
  const [{ data: sales, error: salesError }, { data: pool, error: poolError }, costPeriods] = await Promise.all([
    supabase
      .from("sales_allocations")
      .select("recurring_service_period_id, status, sales_documents(document_number)")
      .in("recurring_service_period_id", cycleIds.length > 0 ? cycleIds : none),
    supabase
      .from("recurring_service_cost_allocations")
      .select("occurrence_id")
      .in("occurrence_id", cycleIds.length > 0 ? cycleIds : none),
    getCostPeriods(companyId, { serviceId }),
  ]);
  if (salesError || poolError) {
    console.error(salesError ?? poolError);
    return { blockers: [], cycles: cycleRows.length, costPeriods: costPeriods.length, failed: true };
  }
  const costPeriodOf = new Map(costPeriods.map((period) => [period.id, monthLabel(period.period.slice(0, 7))]));
  const costs = await getCostServiceAllocations(companyId, { periodIds: costPeriods.map((period) => period.id) });

  const blockers: DeletionBlocker[] = [];
  for (const row of (sales ?? []) as { recurring_service_period_id: string; status: string; sales_documents: Embedded<{ document_number: string | null }> }[]) {
    const number = firstOf(row.sales_documents)?.document_number;
    blockers.push({
      kind: "sales",
      label: `Factura ${number ?? "sin número"} → ciclo ${periodOf.get(row.recurring_service_period_id) ?? ""} (${STATUS[row.status] ?? row.status})`,
    });
  }
  for (const cycle of cycleRows.filter((row) => row.sales_document_id)) {
    blockers.push({
      kind: "linked_invoice",
      label: `Ciclo ${periodOf.get(cycle.id)} → factura ${firstOf(cycle.sales_documents)?.document_number ?? "sin número"}`,
    });
  }
  for (const document of legacy ?? []) {
    blockers.push({
      kind: "legacy_document",
      label: `Documento ${document.document_number ?? "sin número"} del ${formatDisplayDate(document.document_date)}`,
    });
  }
  for (const row of costs) {
    blockers.push({
      kind: "cost",
      label: `${row.supplierName ?? "Factura de compra"} del ${formatDisplayDate(row.documentDate)} → costo de ${costPeriodOf.get(row.costPeriodId) ?? ""} (${STATUS[row.status] ?? row.status})`,
    });
  }
  for (const row of pool ?? []) {
    blockers.push({ kind: "pool", label: `Ciclo ${periodOf.get(row.occurrence_id as string) ?? ""}` });
  }

  return { blockers, cycles: cycleRows.length, costPeriods: costPeriods.length, failed: false };
}
