import "server-only";

import { getSalesListRows, type PaymentStatus, type SalesListFilters, type SalesListRow } from "@/lib/dal";
import { getProfitabilityBreakdown, monthRange } from "@/lib/reporting";
import { PAYMENT_STATUS_OPTIONS } from "@/lib/paymentStatus";
import { currentMonth, resolvePeriod } from "@/lib/period";

export { currentMonth, resolvePeriod, shiftMonth } from "@/lib/period";

/**
 * The sales list as the Excel it replaces: each sale with the cost and
 * profit of its job. Shared by the page and the CSV export so both always
 * show the same numbers for the same filters.
 */

export type SalesSearchParams = {
  from?: string;
  to?: string;
  clientId?: string;
  projectId?: string;
  businessAreaId?: string;
  /** "include" shows annulled documents; drill-downs pass "exclude". */
  voided?: string;
  sort?: string;
  order?: string;
  /** "YYYY-MM", resolved into the same [start, end) range the drill-downs use. */
  period?: string;
  payment?: string;
  /** 1-based page of the list (the totals always cover every page). */
  page?: string;
};

export type SalesViewRow = SalesListRow & {
  /** Share of the job's accumulated cost for this document (null = no job). */
  cost: number | null;
  profit: number | null;
  marginPct: number | null;
};

export type SalesView = {
  filters: SalesListFilters;
  hasActiveFilters: boolean;
  rows: SalesViewRow[];
  error: string | null;
};

const revenueSign = (documentType: string) => (documentType === "credit_note" ? -1 : 1);

export function parseSalesFilters(sp: SalesSearchParams): { filters: SalesListFilters; hasActiveFilters: boolean } {
  const period = resolvePeriod(sp);
  const periodRange = period ? monthRange(`${period}-01`) : null;
  const payment = sp.payment as PaymentStatus | "sin_dato" | undefined;
  const paymentStatus =
    payment === "sin_dato" || (payment && PAYMENT_STATUS_OPTIONS.includes(payment)) ? payment : undefined;

  const filters: SalesListFilters = {
    from: periodRange?.start ?? sp.from,
    to: periodRange?.end ?? sp.to,
    clientId: sp.clientId,
    projectId: sp.projectId,
    businessAreaId: sp.businessAreaId,
    paymentStatus,
    // Annulled documents (a credit note and the invoice it corrects) are
    // out of "ventas": hidden unless asked for.
    excludeVoided: sp.voided !== "include",
    sortBy: sp.sort === "net" ? "net" : sp.sort === "total" ? "total" : "date",
    sortDirection: sp.order === "asc" ? "asc" : "desc",
  };

  return {
    filters,
    hasActiveFilters: Boolean(
      filters.from ||
        filters.to ||
        filters.clientId ||
        filters.projectId ||
        filters.businessAreaId ||
        filters.paymentStatus ||
        sp.voided === "include",
    ),
  };
}

export async function loadSalesView(companyId: string, sp: SalesSearchParams): Promise<SalesView> {
  const { filters, hasActiveFilters } = parseSalesFilters(sp);

  let listRows: SalesListRow[] = [];
  let error: string | null = null;

  try {
    listRows = await getSalesListRows(companyId, filters);
  } catch (thrown) {
    console.error(thrown);
    error = thrown instanceof Error ? thrown.message : "No se pudo leer el listado de ventas.";
  }

  // Accumulated cost / net revenue per job (life to date, the same figures
  // as the job's own page). The period argument only affects the monthly
  // figures, which are not used here.
  const projectFigures = new Map<string, { cost: number; revenue: number }>();
  if (listRows.some((row) => row.project_id)) {
    const breakdown = await getProfitabilityBreakdown(companyId, `${resolvePeriod(sp) ?? currentMonth()}-01`);
    for (const project of breakdown.projects) {
      projectFigures.set(project.id, { cost: project.accumulatedCosts, revenue: project.accumulatedRevenue });
    }
  }

  const rows: SalesViewRow[] = listRows.map((row) => {
    const figures = row.project_id ? projectFigures.get(row.project_id) : undefined;
    // The job's cost is split across its invoices in proportion to net, so
    // the profit of all of them adds up to the job's margin.
    if (!figures || figures.revenue <= 0 || row.voided || row.document_type === "credit_note") {
      return { ...row, cost: null, profit: null, marginPct: null };
    }
    const cost = (figures.cost * row.net_amount) / figures.revenue;
    const profit = row.net_amount - cost;
    return {
      ...row,
      cost,
      profit,
      marginPct: row.net_amount === 0 ? null : (profit / row.net_amount) * 100,
    };
  });

  return { filters, hasActiveFilters, rows, error };
}

export function summarizeRows(rows: SalesViewRow[]) {
  const live = rows.filter((row) => !row.voided);
  const net = live.reduce((sum, row) => sum + revenueSign(row.document_type) * row.net_amount, 0);
  const invoiced = live
    .filter((row) => row.document_type !== "credit_note")
    .reduce((sum, row) => sum + row.net_amount, 0);
  const creditNotes = live
    .filter((row) => row.document_type === "credit_note")
    .reduce((sum, row) => sum + row.net_amount, 0);
  const withJob = live.filter((row) => row.cost !== null);
  const cost = withJob.reduce((sum, row) => sum + (row.cost ?? 0), 0);
  const profit = withJob.reduce((sum, row) => sum + (row.profit ?? 0), 0);
  return { count: live.length, net, invoiced, creditNotes, cost, profit, hasCost: withJob.length > 0 };
}
