import "server-only";

import { createClient } from "@/lib/supabase/server";
import { getSession, getRecurringServices, getSuppliers } from "@/lib/dal";
import { fetchAllPages } from "@/lib/pagination";
import { shiftMonth } from "@/lib/period";
import type { CostSuggestionReason } from "@/lib/costAllocationSuggestions";

/**
 * Purchase invoices allocated to recurring service cost periods
 * (cost_service_allocations, 20261020010000), read with the caller's
 * session (RLS). The model of lib/salesAllocations.ts for sales.
 */

type ApiError = { message: string };

export type CostPeriodRow = {
  id: string;
  recurringServiceId: string;
  serviceName: string;
  clientName: string | null;
  supplierId: string | null;
  /** "YYYY-MM-01" */
  period: string;
  currency: string;
  expected: number;
  /** Confirmed invoices in the period's currency. */
  invoiced: number;
  suggested: number;
  confirmedCount: number;
  suggestedCount: number;
  status: "invoiced" | "estimated";
};

type PeriodSummaryRecord = {
  cost_period_id: string;
  recurring_service_id: string;
  supplier_id: string | null;
  uses_cost_pool: boolean;
  period: string;
  currency: string;
  expected_amount: number | string;
  invoiced_amount: number | string;
  suggested_amount: number | string;
  confirmed_count: number | string;
  suggested_count: number | string;
  cost_status: string;
};

/** Cost periods of the company: of one service, or of the months [fromMonth, toMonth]. */
export async function getCostPeriods(
  companyId: string,
  filters: { serviceId?: string; fromMonth?: string; toMonth?: string; periodIds?: string[] },
): Promise<CostPeriodRow[]> {
  const user = await getSession();
  if (!user) return [];
  if (filters.periodIds && filters.periodIds.length === 0) return [];

  const supabase = await createClient();
  const [{ data, error }, services] = await Promise.all([
    fetchAllPages<PeriodSummaryRecord>((from, to) => {
      let query = supabase
        .from("recurring_service_cost_period_summary")
        .select(
          "cost_period_id, recurring_service_id, supplier_id, uses_cost_pool, period, currency, expected_amount, invoiced_amount, suggested_amount, confirmed_count, suggested_count, cost_status",
        )
        .eq("company_id", companyId)
        .eq("uses_cost_pool", false);
      if (filters.serviceId) query = query.eq("recurring_service_id", filters.serviceId);
      if (filters.fromMonth) query = query.gte("period", `${filters.fromMonth}-01`);
      if (filters.toMonth) query = query.lte("period", `${filters.toMonth}-01`);
      if (filters.periodIds) query = query.in("cost_period_id", filters.periodIds.slice(0, 150));
      return query.order("cost_period_id").range(from, to) as unknown as PromiseLike<{
        data: PeriodSummaryRecord[] | null;
        error: ApiError | null;
      }>;
    }),
    getRecurringServices(companyId),
  ]);
  if (error) console.error(error);

  const serviceById = new Map(services.map((service) => [service.id, service]));
  return data
    .map((row) => {
      const service = serviceById.get(row.recurring_service_id);
      return {
        id: row.cost_period_id,
        recurringServiceId: row.recurring_service_id,
        serviceName: service?.name ?? "Servicio",
        clientName: service?.client_name ?? null,
        supplierId: row.supplier_id,
        period: row.period,
        currency: row.currency,
        expected: Number(row.expected_amount),
        invoiced: Number(row.invoiced_amount),
        suggested: Number(row.suggested_amount),
        confirmedCount: Number(row.confirmed_count),
        suggestedCount: Number(row.suggested_count),
        status: row.cost_status === "invoiced" ? ("invoiced" as const) : ("estimated" as const),
      };
    })
    .sort((a, b) => b.period.localeCompare(a.period) || a.serviceName.localeCompare(b.serviceName, "es"));
}

export type CostServiceAllocationRow = {
  id: string;
  costDocumentId: string;
  costPeriodId: string;
  amount: number;
  /** IVA-included share, when saved from "Editar asignación" (amount is its net). */
  grossAmount: number | null;
  /** Row order in "Editar asignación", shared with cost_allocations.position. */
  position: number | null;
  status: "suggested" | "confirmed";
  reason: CostSuggestionReason | null;
  notes: string | null;
  documentDate: string;
  documentCurrency: string;
  documentNet: number;
  supplierName: string | null;
};

type AllocationRecord = {
  id: string;
  cost_document_id: string;
  cost_period_id: string;
  amount: number | string;
  gross_amount: number | string | null;
  position: number | null;
  status: "suggested" | "confirmed";
  suggestion_reason: CostSuggestionReason | null;
  notes: string | null;
  cost_documents:
    | { document_date: string; currency: string; net_amount: number | string; suppliers: { name: string } | { name: string }[] | null }
    | { document_date: string; currency: string; net_amount: number | string; suppliers: { name: string } | { name: string }[] | null }[]
    | null;
};

function firstOf<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

/** Allocations of some cost periods, or of one cost document, or the suggested ones. */
export async function getCostServiceAllocations(
  companyId: string,
  filters: { periodIds?: string[]; costDocumentId?: string; status?: "suggested" | "confirmed" },
): Promise<CostServiceAllocationRow[]> {
  const user = await getSession();
  if (!user) return [];
  if (filters.periodIds && filters.periodIds.length === 0) return [];

  const supabase = await createClient();
  const chunks: (string[] | null)[] = [];
  if (filters.periodIds) {
    for (let i = 0; i < filters.periodIds.length; i += 150) chunks.push(filters.periodIds.slice(i, i + 150));
  } else {
    chunks.push(null);
  }

  const rows: CostServiceAllocationRow[] = [];
  for (const ids of chunks) {
    const { data, error } = await fetchAllPages<AllocationRecord>((from, to) => {
      let query = supabase
        .from("cost_service_allocations")
        .select(
          "id, cost_document_id, cost_period_id, amount, gross_amount, position, status, suggestion_reason, notes, cost_documents(document_date, currency, net_amount, suppliers(name))",
        )
        .eq("company_id", companyId);
      if (ids) query = query.in("cost_period_id", ids);
      if (filters.costDocumentId) query = query.eq("cost_document_id", filters.costDocumentId);
      if (filters.status) query = query.eq("status", filters.status);
      return query.order("id").range(from, to) as unknown as PromiseLike<{
        data: AllocationRecord[] | null;
        error: ApiError | null;
      }>;
    });
    if (error) console.error(error);
    for (const row of data) {
      const doc = firstOf(row.cost_documents);
      rows.push({
        id: row.id,
        costDocumentId: row.cost_document_id,
        costPeriodId: row.cost_period_id,
        amount: Number(row.amount),
        grossAmount: row.gross_amount === null ? null : Number(row.gross_amount),
        position: row.position,
        status: row.status,
        reason: row.suggestion_reason,
        notes: row.notes,
        documentDate: doc?.document_date ?? "",
        documentCurrency: doc?.currency ?? "",
        documentNet: Number(doc?.net_amount ?? 0),
        supplierName: firstOf(doc?.suppliers)?.name ?? null,
      });
    }
  }
  return rows;
}

/**
 * Destinations for a cost document dated in `month` ("YYYY-MM"): the cost
 * periods of non-pooled services from one month before to one after.
 */
export async function getCostPeriodTargets(companyId: string, month: string): Promise<CostPeriodRow[]> {
  return getCostPeriods(companyId, { fromMonth: shiftMonth(month, -1), toMonth: shiftMonth(month, 1) });
}

/** A cost period a purchase invoice can be allocated to, for the pickers. */
export type ServicePeriodOption = {
  id: string;
  serviceName: string;
  clientName: string | null;
  /** "YYYY-MM-01" */
  period: string;
  currency: string;
  expected: number;
  /** The service is the document's supplier's. */
  sameSupplier: boolean;
};

/**
 * The picker of "Asignar a servicios" and "Editar asignación": the cost
 * periods around the invoice's `month` (getCostPeriodTargets), its
 * supplier's services first, plus `keepPeriodIds` (periods already
 * allocated) even when they fall outside that window.
 */
export async function getServicePeriodOptions(
  companyId: string,
  month: string,
  supplierId: string | null,
  keepPeriodIds: string[],
): Promise<ServicePeriodOption[]> {
  const toOption = (target: CostPeriodRow): ServicePeriodOption => ({
    id: target.id,
    serviceName: target.serviceName,
    clientName: target.clientName,
    period: target.period,
    currency: target.currency,
    expected: target.expected,
    sameSupplier: Boolean(supplierId) && target.supplierId === supplierId,
  });
  const options = (await getCostPeriodTargets(companyId, month))
    .map(toOption)
    .sort(
      (a, b) =>
        Number(b.sameSupplier) - Number(a.sameSupplier) ||
        a.period.localeCompare(b.period) ||
        a.serviceName.localeCompare(b.serviceName, "es"),
    );
  const optionIds = new Set(options.map((option) => option.id));
  const missingIds = keepPeriodIds.filter((periodId) => !optionIds.has(periodId));
  for (const target of await getCostPeriods(companyId, { periodIds: missingIds })) {
    options.push(toOption(target));
  }
  return options;
}

export type SupplierDocument = {
  id: string;
  documentDate: string;
  currency: string;
  netAmount: number;
  serviceAllocated: number;
};

/**
 * Purchase invoices of a supplier dated in `month` that can still be
 * allocated to services: general costs without a job, without
 * cost_allocations, not covered by the MS pool, with something left.
 */
export async function getSupplierDocumentsForMonth(
  companyId: string,
  supplierId: string,
  month: string,
): Promise<SupplierDocument[]> {
  const user = await getSession();
  if (!user) return [];

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("cost_documents")
    .select(
      "id, document_date, recognized_period, currency, net_amount, classification, project_id, covered_by_cost_pool_id, service_allocated_amount, technician_linked_amount, cost_allocations(id)",
    )
    .eq("company_id", companyId)
    .eq("supplier_id", supplierId)
    .eq("classification", "general")
    .is("project_id", null)
    .gte("document_date", `${shiftMonth(month, -1)}-01`)
    .lt("document_date", `${shiftMonth(month, 2)}-01`)
    .order("document_date");
  if (error) console.error(error);

  type Row = {
    id: string;
    document_date: string;
    recognized_period: string | null;
    currency: string;
    net_amount: number | string;
    covered_by_cost_pool_id: string | null;
    service_allocated_amount: number | string | null;
    technician_linked_amount: number | string | null;
    cost_allocations: { id: string }[] | null;
  };
  return ((data ?? []) as Row[])
    .filter(
      (row) =>
        (row.recognized_period ?? row.document_date).slice(0, 7) === month &&
        !row.covered_by_cost_pool_id &&
        (row.cost_allocations ?? []).length === 0 &&
        // The backing of technician charges is not offered to a service.
        Number(row.technician_linked_amount ?? 0) === 0 &&
        Number(row.service_allocated_amount ?? 0) < Number(row.net_amount),
    )
    .map((row) => ({
      id: row.id,
      documentDate: row.document_date,
      currency: row.currency,
      netAmount: Number(row.net_amount),
      serviceAllocated: Number(row.service_allocated_amount ?? 0),
    }));
}

export type PendingCostSuggestion = {
  costDocumentId: string;
  documentDate: string;
  currency: string;
  netAmount: number;
  supplierName: string | null;
  lines: { serviceName: string; clientName: string | null; period: string; amount: number; expected: number }[];
};

/** Suggested (unconfirmed) allocations of purchase invoices, by document; `month` filters by document date. */
export async function getPendingCostSuggestions(
  companyId: string,
  month: string | null,
): Promise<PendingCostSuggestion[]> {
  const suggestions = await getCostServiceAllocations(companyId, { status: "suggested" });
  const relevant = month ? suggestions.filter((row) => row.documentDate.slice(0, 7) === month) : suggestions;
  if (relevant.length === 0) return [];

  const months = [...new Set(relevant.map((row) => row.documentDate.slice(0, 7)))].sort();
  const periods = await getCostPeriods(companyId, {
    fromMonth: shiftMonth(months[0], -2),
    toMonth: shiftMonth(months[months.length - 1], 2),
  });
  const periodById = new Map(periods.map((period) => [period.id, period]));

  const byDocument = new Map<string, PendingCostSuggestion>();
  for (const row of relevant) {
    const entry = byDocument.get(row.costDocumentId) ?? {
      costDocumentId: row.costDocumentId,
      documentDate: row.documentDate,
      currency: row.documentCurrency,
      netAmount: row.documentNet,
      supplierName: row.supplierName,
      lines: [],
    };
    const period = periodById.get(row.costPeriodId);
    entry.lines.push({
      serviceName: period?.serviceName ?? "Servicio",
      clientName: period?.clientName ?? null,
      period: period?.period ?? "",
      amount: row.amount,
      expected: period?.expected ?? 0,
    });
    byDocument.set(row.costDocumentId, entry);
  }
  return [...byDocument.values()].sort((a, b) => b.documentDate.localeCompare(a.documentDate));
}

/** Supplier names of the company, for labels. */
export async function supplierNames(companyId: string): Promise<Map<string, string>> {
  const suppliers = await getSuppliers(companyId);
  return new Map(suppliers.map((supplier) => [supplier.id, supplier.name]));
}
