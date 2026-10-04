/**
 * Totals of a list of cost documents for the costs screen's cards and
 * footer. Only documents in the company's currency are added; documents in
 * another currency are counted apart, per currency -- never converted here
 * and never mixed into the company-currency figure.
 */
export type CostTotals = {
  total: number;
  direct: number;
  general: number;
  otherCurrencies: { currency: string; count: number; net: number }[];
};

export function summarizeCostDocuments(
  documents: { classification: string; net_amount: number | string | null; currency: string }[],
  companyCurrency: string,
): CostTotals {
  let direct = 0;
  let general = 0;
  const others = new Map<string, { currency: string; count: number; net: number }>();

  for (const document of documents) {
    const net = Number(document.net_amount ?? 0);
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
  };
}
