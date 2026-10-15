import "server-only";

import { getSalesListRows, type PaymentStatus, type SalesListFilters, type SalesListRow } from "@/lib/dal";
import { getProfitabilityBreakdown, monthRange } from "@/lib/reporting";
import { isPaymentStatus } from "@/lib/paymentStatus";
import { summarizeMoney, type MoneySummary, type RateTable } from "@/lib/multiCurrency";
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
  recurring?: string;
  /** 1-based page of the list (the totals always cover every page). */
  page?: string;
};

export type SalesViewRow = SalesListRow & {
  /**
   * Share of the job's accumulated cost for this document (null = no job),
   * like profit in the company's currency: the job's figures are, so the
   * document's net is converted with its own stored rate first.
   */
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
  const paymentStatus: PaymentStatus | undefined = isPaymentStatus(sp.payment) ? sp.payment : undefined;
  const recurring =
    sp.recurring === "recurring" || sp.recurring === "non_recurring"
      ? sp.recurring
      : undefined;

  const filters: SalesListFilters = {
    from: periodRange?.start ?? sp.from,
    to: periodRange?.end ?? sp.to,
    clientId: sp.clientId,
    projectId: sp.projectId,
    businessAreaId: sp.businessAreaId,
    paymentStatus,
    recurring,
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
        filters.recurring ||
        sp.voided === "include",
    ),
  };
}

export async function loadSalesView(
  companyId: string,
  sp: SalesSearchParams,
  companyCurrency: string,
): Promise<SalesView> {
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
    const net = netInCompanyCurrency(row, companyCurrency);
    if (!figures || figures.revenue <= 0 || row.voided || row.document_type === "credit_note" || net === null) {
      return { ...row, cost: null, profit: null, marginPct: null };
    }
    const cost = (figures.cost * net) / figures.revenue;
    const profit = net - cost;
    return {
      ...row,
      cost,
      profit,
      marginPct: net === 0 ? null : (profit / net) * 100,
    };
  });

  return { filters, hasActiveFilters, rows, error };
}

/** The document's net in the company's currency, with its own stored rate (null without one). */
function netInCompanyCurrency(row: SalesListRow, companyCurrency: string): number | null {
  if (row.currency === companyCurrency) return row.net_amount;
  return row.exchange_rate === null ? null : row.net_amount * row.exchange_rate;
}

export type SalesTotals = {
  /** Documents added up (annulled ones never are). */
  count: number;
  voided: number;
  /** Invoiced minus credit notes, per currency and in local currency + USD. */
  net: MoneySummary;
  invoiced: MoneySummary;
  /** Credit notes as positive amounts. */
  creditNotes: MoneySummary;
  /** Job cost and profit of the documents with a job, in the company's currency. */
  cost: number;
  profit: number;
  hasCost: boolean;
};

/**
 * The totals of what the list shows, through the shared multi-currency
 * helper (lib/multiCurrency.ts): each currency added apart in its own
 * currency, and the combined total in the company's currency and in USD
 * with the rate of each document's date. Documents of different currencies
 * are never added without converting (docs/verificacion-contable-2026-10-04.md, C10).
 */
export function summarizeRows(rows: SalesViewRow[], companyCurrency: string, rates: RateTable): SalesTotals {
  const voided = rows.filter((row) => row.voided).length;
  const live = rows.filter((row) => !row.voided);
  const item = (row: SalesViewRow, sign: number) => ({
    amount: sign * row.net_amount,
    currency: row.currency,
    date: row.document_date,
    rateToLocal: row.exchange_rate,
  });

  const withJob = live.filter((row) => row.cost !== null);
  return {
    count: live.length,
    voided,
    net: summarizeMoney(live.map((row) => item(row, revenueSign(row.document_type))), companyCurrency, rates),
    invoiced: summarizeMoney(
      live.filter((row) => row.document_type !== "credit_note").map((row) => item(row, 1)),
      companyCurrency,
      rates,
    ),
    creditNotes: summarizeMoney(
      live.filter((row) => row.document_type === "credit_note").map((row) => item(row, 1)),
      companyCurrency,
      rates,
    ),
    cost: withJob.reduce((sum, row) => sum + (row.cost ?? 0), 0),
    profit: withJob.reduce((sum, row) => sum + (row.profit ?? 0), 0),
    hasCost: withJob.length > 0,
  };
}
