/**
 * Pure helpers for invoice allocations, safe on the client (the data
 * access lives in lib/salesAllocations.ts, server-only).
 */

/** Half a peso / half a cent: what still counts as "nothing left". */
export function amountTolerance(currency: string): number {
  return currency === "CLP" ? 0.5 : 0.005;
}

/** "oct 2026" for a monthly period, "Año 2026" for an annual one. */
export function periodLabel(period: string, periodicity: string): string {
  if (periodicity === "annual") return `Año ${period.slice(0, 4)}`;
  const [year, month] = period.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString("es", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** A destination an invoice can be allocated to. */
export type AllocationTarget = {
  type: "period" | "quote";
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
};
