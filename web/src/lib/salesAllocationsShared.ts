/**
 * Pure helpers for invoice allocations, safe on the client (the data
 * access lives in lib/salesAllocations.ts, server-only).
 */

/** Half a peso / half a cent: what still counts as "nothing left". */
export function amountTolerance(currency: string): number {
  return currency === "CLP" ? 0.5 : 0.005;
}

/**
 * Billed minus the period's price (its expected amount), for information
 * only (fix-math 2026-11, point 4): a period is "pagado" when its assigned
 * invoices are collected, whatever this difference (a price change, a partial
 * invoice). Null while nothing is billed or when it is within rounding.
 */
export function periodPriceDifference(period: {
  confirmed_count: number;
  billed_amount: number;
  expected_amount: number;
  currency: string;
}): number | null {
  if (!(period.confirmed_count > 0)) return null;
  const difference = period.billed_amount - period.expected_amount;
  return Math.abs(difference) > amountTolerance(period.currency) ? difference : null;
}

/**
 * "oct 2026" for a monthly period; for an annual one, the year it covers
 * from its anniversary month (20261020020000): "jul 2026 – jun 2027".
 */
export function periodLabel(period: string, periodicity: string): string {
  const [year, month] = period.split("-").map(Number);
  const label = (y: number, m: number) =>
    new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("es", {
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    });
  if (periodicity === "annual") {
    const last = new Date(Date.UTC(year, month + 10, 1));
    return `${label(year, month)} – ${label(last.getUTCFullYear(), last.getUTCMonth() + 1)}`;
  }
  return label(year, month);
}

/** A destination an invoice can be allocated to. */
export type AllocationTarget = {
  /** "project": a job with no quote of its own (the document goes to its internal quote). */
  type: "period" | "quote" | "project";
  id: string;
  label: string;
  detail: string;
  clientId: string | null;
  clientName: string | null;
  currency: string | null;
  /** Expected (period) or quoted (quote) amount. */
  expected: number | null;
  /** What is already billed there (confirmed allocations). */
  billed: number;
  serviceType: string | null;
  /** Due month of a period ("YYYY-MM"). */
  month: string | null;
  projectId: string | null;
};

export type AllocationStatus = "suggested" | "confirmed";

export type SalesAllocation = {
  id: string;
  sales_document_id: string;
  recurring_service_period_id: string | null;
  project_quote_id: string | null;
  amount: number;
  status: AllocationStatus;
  notes: string | null;
  /** Why it was suggested (lib/allocationSuggestions.ts); null when made by hand. */
  suggestion_reason: "exact" | "single_period" | "proportional" | "quote" | null;
};
