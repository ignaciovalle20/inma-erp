import { summarizeMoney, type MoneySummary, type RateTable } from "@/lib/multiCurrency";

/**
 * Totals of a list of cost documents for the costs screen's cards and
 * footer, through the shared multi-currency helper (lib/multiCurrency.ts):
 * each currency added apart in its own currency, and the combined total in
 * the company's currency and in USD with the rate of each document's date.
 * Currencies are never added without converting
 * (docs/verificacion-contable-2026-10-04.md, C11). Net amounts only.
 *
 * A document "cubierto por pool" (the Microsoft invoice of a month that
 * already has an MS licenses pool, point 5 of
 * docs/verificacion-contable-2026-10-04.md) is listed but never added: the
 * pool already carries that cost. It is counted apart in `coveredByPool`.
 */
export type CostTotals = {
  total: MoneySummary;
  direct: MoneySummary;
  general: MoneySummary;
  /** Documents covered by an MS licenses pool (not added). */
  coveredByPool: { count: number };
};

type CostDocumentAmount = {
  classification: string;
  net_amount: number | string | null;
  currency: string;
  document_date?: string | null;
  /** Units of the company's currency per unit of `currency` (stored on the document). */
  exchange_rate?: number | string | null;
  covered_by_cost_pool_id?: string | null;
  /**
   * The part of a factura / boleta that the technician charges it backs
   * carry (20261028010000): the charges' own costs are in the list too, so
   * only the rest of the document is added.
   */
  technician_linked_amount?: number | string | null;
};

export function summarizeCostDocuments(
  documents: CostDocumentAmount[],
  companyCurrency: string,
  rates: RateTable,
): CostTotals {
  const counted = documents.filter((document) => !document.covered_by_cost_pool_id);
  const item = (document: CostDocumentAmount) => ({
    amount: Number(document.net_amount ?? 0) - Number(document.technician_linked_amount ?? 0),
    currency: document.currency,
    date: document.document_date ?? "",
    rateToLocal: document.exchange_rate ?? null,
  });
  const of = (list: CostDocumentAmount[]) => summarizeMoney(list.map(item), companyCurrency, rates);

  return {
    total: of(counted),
    direct: of(counted.filter((document) => document.classification === "direct")),
    general: of(counted.filter((document) => document.classification !== "direct")),
    coveredByPool: { count: documents.length - counted.length },
  };
}
