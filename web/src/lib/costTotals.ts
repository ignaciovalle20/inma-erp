/**
 * Totals of a list of cost documents for the costs screen's cards and
 * footer. Only documents in the company's currency are added; documents in
 * another currency are counted apart, per currency -- never converted here
 * and never mixed into the company-currency figure.
 *
 * A document "cubierto por pool" (the Microsoft invoice of a month that
 * already has an MS licenses pool, point 5 of
 * docs/verificacion-contable-2026-10-04.md) is listed but never added: the
 * pool already carries that cost. It is counted apart in `coveredByPool`.
 */
export type CostTotals = {
  total: number;
  direct: number;
  general: number;
  otherCurrencies: { currency: string; count: number; net: number }[];
  /** Documents covered by an MS licenses pool (any currency, net as stored). */
  coveredByPool: { count: number; net: number };
};

export function summarizeCostDocuments(
  documents: {
    classification: string;
    net_amount: number | string | null;
    currency: string;
    covered_by_cost_pool_id?: string | null;
  }[],
  companyCurrency: string,
): CostTotals {
  let direct = 0;
  let general = 0;
  const others = new Map<string, { currency: string; count: number; net: number }>();
  const coveredByPool = { count: 0, net: 0 };

  for (const document of documents) {
    const net = Number(document.net_amount ?? 0);
    if (document.covered_by_cost_pool_id) {
      coveredByPool.count += 1;
      coveredByPool.net += net;
      continue;
    }
    if (document.currency !== companyCurrency) {
      const entry = others.get(document.currency) ?? { currency: document.currency, count: 0, net: 0 };
      entry.count += 1;
      entry.net += net;
      others.set(document.currency, entry);
      continue;
    }
    if (document.classification === "direct") direct += net;
    else general += net;
  }

  return {
    total: direct + general,
    direct,
    general,
    otherCurrencies: [...others.values()].sort((a, b) => a.currency.localeCompare(b.currency)),
    coveredByPool,
  };
}
