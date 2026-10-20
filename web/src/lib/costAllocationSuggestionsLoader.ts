/**
 * Runs the purchase-invoice -> service rules (lib/costAllocationSuggestions.ts)
 * against the database with the client it is given (the caller's session in
 * the app, so RLS keeps it to their company; a member's client in the
 * integration tests). Called after a purchase import, after a cost is created
 * by hand, after cost periods are generated, and from "Sugerir asignaciones".
 */
import type { createClient } from "@/lib/supabase/server";
import { fetchAllPages } from "@/lib/pagination";
import {
  proposeCostAllocations,
  type CostCandidateDocument,
  type CostCandidatePeriod,
} from "@/lib/costAllocationSuggestions";

type Supabase = Awaited<ReturnType<typeof createClient>>;

type ApiError = { message: string };

type DocumentRecord = {
  id: string;
  supplier_id: string | null;
  currency: string;
  net_amount: number | string;
  document_date: string;
  recognized_period: string | null;
  classification: string;
  project_id: string | null;
  covered_by_cost_pool_id: string | null;
  cost_allocations: { id: string }[] | null;
  cost_service_allocations: { id: string }[] | null;
};

type PeriodRecord = {
  cost_period_id: string;
  recurring_service_id: string;
  supplier_id: string | null;
  uses_cost_pool: boolean;
  period: string;
  currency: string;
  expected_amount: number | string;
  confirmed_count: number | string;
  suggested_count: number | string;
};

export type CostSuggestionResult = {
  /** Documents allocated and confirmed by the rules. */
  confirmed: number;
  /** Documents left as a suggestion to confirm. */
  suggested: number;
  error: string | null;
};

function monthOf(document: { recognized_period: string | null; document_date: string }): string {
  return (document.recognized_period ?? document.document_date).slice(0, 7);
}

/**
 * Allocates the company's purchase invoices that have no allocation yet --
 * all of them, the given ids, or those of one month ("YYYY-MM") -- to the
 * cost periods of the same supplier, month and currency that have no
 * invoice. A document that already has any service allocation is never
 * touched, so running this again never duplicates anything.
 */
export async function suggestCostAllocations(
  supabase: Supabase,
  companyId: string,
  options: { documentIds?: string[] | null; month?: string | null; supplierId?: string | null } = {},
): Promise<CostSuggestionResult> {
  const empty: CostSuggestionResult = { confirmed: 0, suggested: 0, error: null };
  if (options.documentIds && options.documentIds.length === 0) return empty;

  const idChunks: (string[] | null)[] = [];
  if (options.documentIds) {
    for (let i = 0; i < options.documentIds.length; i += 150) idChunks.push(options.documentIds.slice(i, i + 150));
  } else {
    idChunks.push(null);
  }

  const documents: DocumentRecord[] = [];
  for (const ids of idChunks) {
    const { data, error } = await fetchAllPages<DocumentRecord>((from, to) => {
      let query = supabase
        .from("cost_documents")
        .select(
          "id, supplier_id, currency, net_amount, document_date, recognized_period, classification, project_id, covered_by_cost_pool_id, cost_allocations(id), cost_service_allocations(id)",
        )
        .eq("company_id", companyId)
        .eq("classification", "general")
        .is("project_id", null)
        .not("supplier_id", "is", null)
        .gt("net_amount", 0);
      if (ids) query = query.in("id", ids);
      if (options.supplierId) query = query.eq("supplier_id", options.supplierId);
      if (options.month) {
        // The month is the recognized period, else the date: read a month
        // around it and keep the right ones below.
        const [year, month] = options.month.split("-").map(Number);
        const windowStart = new Date(Date.UTC(year, month - 3, 1)).toISOString().slice(0, 10);
        const windowEnd = new Date(Date.UTC(year, month + 1, 1)).toISOString().slice(0, 10);
        query = query.gte("document_date", windowStart).lt("document_date", windowEnd);
      }
      return query.order("id").range(from, to) as unknown as PromiseLike<{
        data: DocumentRecord[] | null;
        error: ApiError | null;
      }>;
    });
    if (error) return { ...empty, error: error.message };
    documents.push(...data);
  }

  const candidates: CostCandidateDocument[] = documents
    .filter(
      (doc) =>
        !doc.covered_by_cost_pool_id &&
        (doc.cost_allocations ?? []).length === 0 &&
        (doc.cost_service_allocations ?? []).length === 0 &&
        (!options.month || monthOf(doc) === options.month),
    )
    .map((doc) => ({
      id: doc.id,
      supplierId: doc.supplier_id as string,
      currency: doc.currency,
      netAmount: Number(doc.net_amount),
      month: monthOf(doc),
      documentDate: doc.document_date,
    }));
  if (candidates.length === 0) return empty;

  const months = [...new Set(candidates.map((doc) => doc.month))].sort();
  const [periods, services] = await Promise.all([
    fetchAllPages<PeriodRecord>((from, to) =>
      supabase
        .from("recurring_service_cost_period_summary")
        .select(
          "cost_period_id, recurring_service_id, supplier_id, uses_cost_pool, period, currency, expected_amount, confirmed_count, suggested_count",
        )
        .eq("company_id", companyId)
        .gte("period", `${months[0]}-01`)
        .lte("period", `${months[months.length - 1]}-01`)
        .order("cost_period_id")
        .range(from, to) as unknown as PromiseLike<{ data: PeriodRecord[] | null; error: ApiError | null }>,
    ),
    fetchAllPages<{ id: string; name: string }>((from, to) =>
      supabase
        .from("recurring_services")
        .select("id, name")
        .eq("company_id", companyId)
        .order("id")
        .range(from, to) as unknown as PromiseLike<{ data: { id: string; name: string }[] | null; error: ApiError | null }>,
    ),
  ]);
  if (periods.error || services.error) return { ...empty, error: (periods.error ?? services.error)!.message };

  const serviceName = new Map(services.data.map((service) => [service.id, service.name]));
  const openPeriods: CostCandidatePeriod[] = periods.data
    .filter(
      (period) =>
        !period.uses_cost_pool &&
        period.supplier_id &&
        Number(period.confirmed_count) === 0 &&
        Number(period.suggested_count) === 0,
    )
    .map((period) => ({
      id: period.cost_period_id,
      supplierId: period.supplier_id as string,
      currency: period.currency,
      month: period.period.slice(0, 7),
      expected: Number(period.expected_amount),
      serviceName: serviceName.get(period.recurring_service_id) ?? "",
    }));

  const proposals = proposeCostAllocations(candidates, openPeriods);
  const byDocument = new Map<string, typeof proposals>();
  for (const proposal of proposals) {
    byDocument.set(proposal.documentId, [...(byDocument.get(proposal.documentId) ?? []), proposal]);
  }

  const result = { ...empty };
  let lastError: string | null = null;
  // One insert per document: one that changed meanwhile fails alone.
  for (const [documentId, rows] of byDocument) {
    const { error } = await supabase.from("cost_service_allocations").insert(
      rows.map((row) => ({
        company_id: companyId,
        cost_document_id: documentId,
        cost_period_id: row.costPeriodId,
        amount: row.amount,
        status: row.status,
        suggestion_reason: row.reason,
      })),
    );
    if (error) {
      console.error(error);
      lastError = error.message;
      continue;
    }
    if (rows[0].status === "confirmed") result.confirmed += 1;
    else result.suggested += 1;
  }
  if (result.confirmed + result.suggested === 0 && lastError) result.error = lastError;
  return result;
}
