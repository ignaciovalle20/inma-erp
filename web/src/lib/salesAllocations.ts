import "server-only";

import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import { getSession, getClients, getProjects, getRecurringServices } from "@/lib/dal";
import { fetchAllPages } from "@/lib/pagination";
import { shiftMonth } from "@/lib/period";
import type { PeriodBillingStatus } from "@/lib/recurringServiceTypes";
import { boardMonthOf } from "@/lib/recurringServicePending";
import {
  amountTolerance,
  periodLabel,
  type AllocationStatus,
  type AllocationTarget,
  type SalesAllocation,
} from "@/lib/salesAllocationsShared";

export { amountTolerance, periodLabel };
export type { AllocationStatus, AllocationTarget, SalesAllocation };

/**
 * Invoice allocations (sales_allocations, 20261016010000): a sales document
 * is split by hand among recurring service periods and job quotes, and the
 * summary views say per document, per period and per quote what is billed
 * and what is left. Everything here runs with the caller's session (RLS).
 */

type Supabase = Awaited<ReturnType<typeof createClient>>;

type ApiError = { message: string };

/** Every page of a view query (views have no `id`, so the order column is explicit). */
async function readAll<T>(
  build: () => { order(column: string): { range(from: number, to: number): PromiseLike<{ data: T[] | null; error: ApiError | null }> } },
  orderColumn: string,
): Promise<{ data: T[]; error: ApiError | null }> {
  return fetchAllPages((from, to) => build().order(orderColumn).range(from, to));
}

// ---------------------------------------------------------------------
// Periods
// ---------------------------------------------------------------------

export type PeriodSummary = {
  id: string;
  recurring_service_id: string;
  client_id: string;
  service_type: string | null;
  requires_invoice: boolean;
  period: string;
  invoice_due_date: string | null;
  currency: string;
  quantity: number | null;
  expected_amount: number;
  billed_amount: number;
  suggested_amount: number;
  difference: number;
  confirmed_count: number;
  suggested_count: number;
  status: string;
  billing_status: PeriodBillingStatus;
};

const PERIOD_SUMMARY_COLUMNS =
  "recurring_service_period_id, recurring_service_id, client_id, service_type, requires_invoice, period, invoice_due_date, currency, quantity, expected_amount, billed_amount, suggested_amount, difference, confirmed_count, suggested_count, status, billing_status";

type PeriodSummaryRecord = Omit<PeriodSummary, "id"> & { recurring_service_period_id: string };

function toPeriodSummary(row: PeriodSummaryRecord): PeriodSummary {
  const { recurring_service_period_id, ...rest } = row;
  return {
    ...rest,
    id: recurring_service_period_id,
    quantity: rest.quantity === null ? null : Number(rest.quantity),
    expected_amount: Number(rest.expected_amount),
    billed_amount: Number(rest.billed_amount),
    suggested_amount: Number(rest.suggested_amount),
    difference: Number(rest.difference),
    confirmed_count: Number(rest.confirmed_count),
    suggested_count: Number(rest.suggested_count),
  };
}

/**
 * Creates every missing period of the company's active services from
 * September 2026 through `untilMonth` ("YYYY-MM"), idempotent. Returns how
 * many it created, or null on error.
 */
export async function ensureRecurringServicePeriods(
  companyId: string,
  untilMonth: string,
): Promise<number | null> {
  const user = await getSession();
  if (!user) return null;

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("ensure_recurring_service_periods", {
    p_company_id: companyId,
    p_until: `${untilMonth}-01`,
  });

  if (error) {
    console.error(error);
    return null;
  }
  return typeof data === "number" ? data : 0;
}

/**
 * Period summaries of a company: from `fromMonth` ("YYYY-MM", by due
 * month) on, or of one service, or the given ids.
 */
export async function getPeriodSummaries(
  companyId: string,
  filters: { fromMonth?: string; serviceId?: string; ids?: string[] },
): Promise<PeriodSummary[]> {
  const user = await getSession();
  if (!user) return [];
  if (filters.ids && filters.ids.length === 0) return [];

  const supabase = await createClient();
  const { data, error } = await readAll<PeriodSummaryRecord>(() => {
    let query = supabase
      .from("recurring_service_period_summary")
      .select(PERIOD_SUMMARY_COLUMNS)
      .eq("company_id", companyId);
    if (filters.serviceId) query = query.eq("recurring_service_id", filters.serviceId);
    if (filters.ids) query = query.in("recurring_service_period_id", filters.ids);
    if (filters.fromMonth) {
      // Twelve months back on the period itself: an annual period starts in
      // January but is due in its renewal month.
      query = query.or(
        `invoice_due_date.gte.${filters.fromMonth}-01,and(invoice_due_date.is.null,period.gte.${shiftMonth(filters.fromMonth, -12)}-01)`,
      );
    }
    return query as unknown as {
      order(column: string): {
        range(from: number, to: number): PromiseLike<{ data: PeriodSummaryRecord[] | null; error: ApiError | null }>;
      };
    };
  }, "recurring_service_period_id");

  if (error) console.error(error);
  return data.map(toPeriodSummary);
}

/** One period with what its page shows of the service and client. */
export type PeriodDetail = PeriodSummary & {
  service_name: string;
  client_name: string | null;
  pricing_mode: "fixed" | "per_unit";
  unit_price: number | null;
  reference_amount: number | null;
  periodicity: string;
  invoicing_mode: string;
  due_month: number | null;
  note: string | null;
  board_month: string;
};

export async function getPeriodDetail(companyId: string, periodId: string): Promise<PeriodDetail | null> {
  const [summaries, services] = await Promise.all([
    getPeriodSummaries(companyId, { ids: [periodId] }),
    getRecurringServices(companyId),
  ]);
  const summary = summaries[0];
  if (!summary) return null;
  const service = services.find((s) => s.id === summary.recurring_service_id);
  if (!service) return null;

  const supabase = await createClient();
  const { data } = await supabase
    .from("recurring_service_occurrences")
    .select("note")
    .eq("id", periodId)
    .maybeSingle();

  return {
    ...summary,
    service_name: service.name,
    client_name: service.client_name,
    pricing_mode: service.pricing_mode,
    unit_price: service.unit_price,
    reference_amount: service.reference_amount,
    periodicity: service.periodicity,
    invoicing_mode: service.invoicing_mode,
    due_month: service.due_month,
    note: data?.note ?? null,
    board_month: boardMonthOf({
      invoice_due_date: summary.invoice_due_date,
      period: summary.period,
      service_periodicity: service.periodicity,
      service_invoicing_mode: service.invoicing_mode,
      service_due_month: service.due_month,
    }),
  };
}

// ---------------------------------------------------------------------
// Allocations
// ---------------------------------------------------------------------

const ALLOCATION_COLUMNS =
  "id, sales_document_id, recurring_service_period_id, project_quote_id, amount, status, notes";

function toAllocation(row: Record<string, unknown>): SalesAllocation {
  return {
    id: row.id as string,
    sales_document_id: row.sales_document_id as string,
    recurring_service_period_id: (row.recurring_service_period_id as string | null) ?? null,
    project_quote_id: (row.project_quote_id as string | null) ?? null,
    amount: Number(row.amount),
    status: row.status as AllocationStatus,
    notes: (row.notes as string | null) ?? null,
  };
}

export async function getAllocationsForDocument(
  companyId: string,
  salesDocumentId: string,
): Promise<SalesAllocation[]> {
  const user = await getSession();
  if (!user) return [];

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("sales_allocations")
    .select(ALLOCATION_COLUMNS)
    .eq("company_id", companyId)
    .eq("sales_document_id", salesDocumentId)
    .order("created_at");

  if (error) console.error(error);
  return (data ?? []).map(toAllocation);
}

export type PeriodAllocation = SalesAllocation & {
  document_type: string;
  document_number: string | null;
  document_date: string;
  currency: string;
  net_amount: number;
  payment_status: string;
  paid_at: string | null;
};

/** The invoices allocated to one period (or quote), with what each one is. */
export async function getAllocationsForTarget(
  companyId: string,
  target: { periodId?: string; quoteIds?: string[] },
): Promise<PeriodAllocation[]> {
  const user = await getSession();
  if (!user) return [];
  if (target.quoteIds && target.quoteIds.length === 0) return [];

  const supabase = await createClient();
  let query = supabase
    .from("sales_allocations")
    .select(
      `${ALLOCATION_COLUMNS}, sales_documents(document_type, document_number, document_date, currency, net_amount, payment_status, paid_at)`,
    )
    .eq("company_id", companyId);
  if (target.periodId) query = query.eq("recurring_service_period_id", target.periodId);
  if (target.quoteIds) query = query.in("project_quote_id", target.quoteIds);

  const { data, error } = await query.order("created_at");
  if (error) console.error(error);

  return (data ?? []).map((row) => {
    type Doc = {
      document_type: string;
      document_number: string | null;
      document_date: string;
      currency: string;
      net_amount: number;
      payment_status: string;
      paid_at: string | null;
    };
    const embedded = (row as { sales_documents: Doc | Doc[] | null }).sales_documents;
    const doc = Array.isArray(embedded) ? embedded[0] : embedded;
    return {
      ...toAllocation(row as Record<string, unknown>),
      document_type: doc?.document_type ?? "invoice",
      document_number: doc?.document_number ?? null,
      document_date: doc?.document_date ?? "",
      currency: doc?.currency ?? "",
      net_amount: Number(doc?.net_amount ?? 0),
      payment_status: doc?.payment_status ?? "impago",
      paid_at: doc?.paid_at ?? null,
    };
  });
}

export type QuoteBilling = {
  project_quote_id: string;
  project_id: string;
  quote_number: string;
  placeholder: boolean;
  quoted_amount: number | null;
  billed_amount: number;
  suggested_amount: number;
  billed_pct: number | null;
};

/** Billed vs. quoted per quote (project_quote_billing_summary). */
export const getQuoteBilling = cache(async (
  companyId: string,
  projectId: string | null,
): Promise<QuoteBilling[]> => {
  const user = await getSession();
  if (!user) return [];

  const supabase = await createClient();
  const { data, error } = await readAll<QuoteBilling>(() => {
    let query = supabase
      .from("project_quote_billing_summary")
      .select("project_quote_id, project_id, quote_number, placeholder, quoted_amount, billed_amount, suggested_amount, billed_pct")
      .eq("company_id", companyId);
    if (projectId) query = query.eq("project_id", projectId);
    return query as unknown as {
      order(column: string): {
        range(from: number, to: number): PromiseLike<{ data: QuoteBilling[] | null; error: ApiError | null }>;
      };
    };
  }, "project_quote_id");

  if (error) console.error(error);
  return data.map((row) => ({
    ...row,
    quoted_amount: row.quoted_amount === null ? null : Number(row.quoted_amount),
    billed_amount: Number(row.billed_amount),
    suggested_amount: Number(row.suggested_amount),
    billed_pct: row.billed_pct === null ? null : Number(row.billed_pct),
  }));
});

/**
 * Billed vs. quoted for a whole job: the sum over its quotes (placeholder
 * included). Quoted falls back to the job's own quoted amount when no
 * quote carries one.
 */
export function projectBillingTotals(
  quotes: QuoteBilling[],
  projectQuotedAmount: number | null,
): { quoted: number | null; billed: number; suggested: number; pct: number | null } {
  const billed = quotes.reduce((sum, q) => sum + q.billed_amount, 0);
  const suggested = quotes.reduce((sum, q) => sum + q.suggested_amount, 0);
  const withAmount = quotes.filter((q) => q.quoted_amount !== null);
  const quoted =
    withAmount.length > 0
      ? withAmount.reduce((sum, q) => sum + (q.quoted_amount ?? 0), 0)
      : projectQuotedAmount;
  return {
    quoted,
    billed,
    suggested,
    pct: quoted && quoted > 0 ? Math.round((1000 * billed) / quoted) / 10 : null,
  };
}

/**
 * Destinations for an invoice of `clientId` dated in `documentMonth`
 * ("YYYY-MM"): the live periods due from six months before to three
 * after, and the quotes of jobs that are not cancelled. `clientId` null =
 * every client.
 */
export async function getAllocationTargets(
  companyId: string,
  options: { clientId: string | null; documentMonth: string },
): Promise<AllocationTarget[]> {
  const [periods, services, quotes, projects, clients] = await Promise.all([
    getPeriodSummaries(companyId, { fromMonth: shiftMonth(options.documentMonth, -6) }),
    getRecurringServices(companyId),
    getQuoteBilling(companyId, null),
    getProjects(companyId),
    getClients(companyId),
  ]);

  const serviceById = new Map(services.map((s) => [s.id, s]));
  const clientName = new Map(clients.map((c) => [c.id, c.name]));
  const lastMonth = shiftMonth(options.documentMonth, 3);

  const periodTargets: AllocationTarget[] = periods.flatMap((p) => {
    const service = serviceById.get(p.recurring_service_id);
    if (!service || p.billing_status === "void") return [];
    if (options.clientId && service.client_id !== options.clientId) return [];
    const month = boardMonthOf({
      invoice_due_date: p.invoice_due_date,
      period: p.period,
      service_periodicity: service.periodicity,
      service_invoicing_mode: service.invoicing_mode,
      service_due_month: service.due_month,
    });
    if (month > lastMonth) return [];
    return [
      {
        type: "period" as const,
        id: p.id,
        label: service.name,
        detail: periodLabel(p.period, service.periodicity),
        clientId: service.client_id,
        clientName: service.client_name,
        currency: p.currency,
        expected: p.expected_amount,
        billed: p.billed_amount,
        serviceType: service.service_type,
        month,
        projectId: null,
      },
    ];
  });

  const projectById = new Map(projects.map((p) => [p.id, p]));
  const quoteTargets: AllocationTarget[] = quotes.flatMap((q) => {
    const project = projectById.get(q.project_id);
    if (!project || project.status === "cancelado") return [];
    if (options.clientId && project.client_id !== options.clientId) return [];
    return [
      {
        type: "quote" as const,
        id: q.project_quote_id,
        label: project.name,
        detail: q.placeholder ? "Sin número de cotización" : `COT ${q.quote_number}`,
        clientId: project.client_id,
        clientName: clientName.get(project.client_id) ?? project.client_name,
        currency: null,
        expected: q.quoted_amount,
        billed: q.billed_amount,
        serviceType: null,
        month: null,
        projectId: project.id,
      },
    ];
  });

  return [
    ...periodTargets.sort((a, b) => (a.month ?? "").localeCompare(b.month ?? "") || a.label.localeCompare(b.label, "es")),
    ...quoteTargets.sort((a, b) => a.label.localeCompare(b.label, "es")),
  ];
}

/**
 * Labels for the destinations an invoice already has, wherever they are
 * (outside the window getAllocationTargets offers, other clients...).
 */
export async function describeAllocationTargets(
  companyId: string,
  allocations: SalesAllocation[],
): Promise<Map<string, AllocationTarget>> {
  const periodIds = allocations.flatMap((a) => (a.recurring_service_period_id ? [a.recurring_service_period_id] : []));
  const hasQuotes = allocations.some((a) => a.project_quote_id);
  const [periods, services, quotes, projects] = await Promise.all([
    getPeriodSummaries(companyId, { ids: periodIds }),
    periodIds.length > 0 ? getRecurringServices(companyId) : Promise.resolve([]),
    hasQuotes ? getQuoteBilling(companyId, null) : Promise.resolve([]),
    hasQuotes ? getProjects(companyId) : Promise.resolve([]),
  ]);

  const result = new Map<string, AllocationTarget>();
  const serviceById = new Map(services.map((s) => [s.id, s]));
  for (const p of periods) {
    const service = serviceById.get(p.recurring_service_id);
    result.set(p.id, {
      type: "period",
      id: p.id,
      label: service?.name ?? "Servicio",
      detail: periodLabel(p.period, service?.periodicity ?? "monthly"),
      clientId: service?.client_id ?? null,
      clientName: service?.client_name ?? null,
      currency: p.currency,
      expected: p.expected_amount,
      billed: p.billed_amount,
      serviceType: service?.service_type ?? null,
      month: service
        ? boardMonthOf({
            invoice_due_date: p.invoice_due_date,
            period: p.period,
            service_periodicity: service.periodicity,
            service_invoicing_mode: service.invoicing_mode,
            service_due_month: service.due_month,
          })
        : null,
      projectId: null,
    });
  }
  const projectById = new Map(projects.map((p) => [p.id, p]));
  for (const q of quotes) {
    if (!allocations.some((a) => a.project_quote_id === q.project_quote_id)) continue;
    const project = projectById.get(q.project_id);
    result.set(q.project_quote_id, {
      type: "quote",
      id: q.project_quote_id,
      label: project?.name ?? "Trabajo",
      detail: q.placeholder ? "Sin número de cotización" : `COT ${q.quote_number}`,
      clientId: project?.client_id ?? null,
      clientName: project?.client_name ?? null,
      currency: null,
      expected: q.quoted_amount,
      billed: q.billed_amount,
      serviceType: null,
      month: null,
      projectId: q.project_id,
    });
  }
  return result;
}

// ---------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------

export type DocumentAllocationSummary = {
  sales_document_id: string;
  client_id: string | null;
  client_name: string | null;
  document_type: string;
  document_number: string | null;
  document_date: string;
  currency: string;
  net_amount: number;
  payment_status: string;
  confirmed_amount: number;
  suggested_amount: number;
  allocated_amount: number;
  unallocated_amount: number;
  suggested_count: number;
  allocation_count: number;
};

const DOCUMENT_SUMMARY_COLUMNS =
  "sales_document_id, client_id, document_type, document_number, document_date, currency, net_amount, payment_status, confirmed_amount, suggested_amount, allocated_amount, unallocated_amount, suggested_count, allocation_count";

type DocumentSummaryRecord = Omit<DocumentAllocationSummary, "client_name">;

function toDocumentSummary(row: DocumentSummaryRecord, clientName: string | null): DocumentAllocationSummary {
  return {
    ...row,
    client_name: clientName,
    net_amount: Number(row.net_amount),
    confirmed_amount: Number(row.confirmed_amount),
    suggested_amount: Number(row.suggested_amount),
    allocated_amount: Number(row.allocated_amount),
    unallocated_amount: Number(row.unallocated_amount),
    suggested_count: Number(row.suggested_count),
    allocation_count: Number(row.allocation_count),
  };
}

export async function getDocumentAllocationSummary(
  companyId: string,
  salesDocumentId: string,
): Promise<DocumentAllocationSummary | null> {
  const user = await getSession();
  if (!user) return null;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("sales_document_allocation_summary")
    .select(DOCUMENT_SUMMARY_COLUMNS)
    .eq("company_id", companyId)
    .eq("sales_document_id", salesDocumentId)
    .maybeSingle();

  if (error) console.error(error);
  if (!data) return null;
  return toDocumentSummary(data as DocumentSummaryRecord, null);
}

/**
 * "Pendientes de conciliar": documents with an unallocated balance or
 * suggestions still to confirm, newest first; `month` ("YYYY-MM") filters
 * by document date (the monthly close), null = every month.
 */
export async function getReconciliationQueue(
  companyId: string,
  month: string | null,
): Promise<{ rows: DocumentAllocationSummary[]; failed: boolean }> {
  const user = await getSession();
  if (!user) return { rows: [], failed: false };

  const supabase = await createClient();
  const [{ data, error }, clients] = await Promise.all([
    readAll<DocumentSummaryRecord>(() => {
      let query = supabase
        .from("sales_document_allocation_summary")
        .select(DOCUMENT_SUMMARY_COLUMNS)
        .eq("company_id", companyId)
        .or("unallocated_amount.gt.0,suggested_count.gt.0");
      if (month) {
        query = query.gte("document_date", `${month}-01`).lt("document_date", `${shiftMonth(month, 1)}-01`);
      }
      return query as unknown as {
        order(column: string): {
          range(from: number, to: number): PromiseLike<{ data: DocumentSummaryRecord[] | null; error: ApiError | null }>;
        };
      };
    }, "sales_document_id"),
    getClients(companyId),
  ]);

  if (error) console.error(error);
  const clientName = new Map(clients.map((c) => [c.id, c.name]));

  const rows = data
    .map((row) => toDocumentSummary(row, row.client_id ? (clientName.get(row.client_id) ?? null) : null))
    .filter(
      (row) => row.suggested_count > 0 || Math.abs(row.unallocated_amount) > amountTolerance(row.currency),
    )
    .sort((a, b) => b.document_date.localeCompare(a.document_date) || (b.document_number ?? "").localeCompare(a.document_number ?? ""));

  return { rows, failed: Boolean(error) };
}

/** Runs the automatic suggestions for the whole company (or some documents). */
export async function suggestAllocations(
  supabase: Supabase,
  companyId: string,
  documentIds: string[] | null = null,
): Promise<{ created: number; error: string | null }> {
  const { data, error } = await supabase.rpc("suggest_sales_allocations", {
    p_company_id: companyId,
    p_sales_document_ids: documentIds,
  });
  if (error) {
    console.error(error);
    return { created: 0, error: error.message };
  }
  const docs = new Set(((data ?? []) as { sales_document_id: string }[]).map((r) => r.sales_document_id));
  return { created: docs.size, error: null };
}
