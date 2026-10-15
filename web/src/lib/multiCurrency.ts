/**
 * The one place where amounts in different currencies are added up. Every
 * summary and total of the system (sales, costs, dashboard, reports,
 * recurring services) goes through `summarizeMoney`, so they all follow the
 * same rules:
 *
 *  - Amounts are added per currency, in that currency (`byCurrency`): "USD
 *    1.000 + UYU 40.000", never "41.000".
 *  - The combined total is given twice: in the company's local currency
 *    (UYU for Uruguay, CLP for Chile) and in USD.
 *  - Each amount converts with the rate of its own date: the
 *    exchange_rate_snapshots row of that month or, if there is none, the
 *    nearest earlier one (the same rule as exchange_rate_on in the
 *    database). A document that already stores its rate to the local
 *    currency (sales_documents.exchange_rate, set on that same rule when it
 *    was created) converts to the local currency with it, so the total
 *    matches the monthly result.
 *  - When there is no rate at all, the amount is left out of that combined
 *    total and the total is flagged incomplete -- never a guessed 1:1.
 *
 * Pure (no database): the rates come in as a RateTable, built by
 * lib/rateTable.ts on the server.
 */

/** A row of exchange_rate_snapshots: ARS per unit of `currency` and ARS per USD for a month. */
export type RateSnapshot = {
  currency: string;
  period: string;
  ars_per_unit: number | string;
  ars_per_usd: number | string;
};

/** USD per unit of each currency, by month (ascending). */
export type RateTable = Map<string, { period: string; usdPerUnit: number }[]>;

export function buildRateTable(snapshots: RateSnapshot[]): RateTable {
  const table: RateTable = new Map();
  for (const snapshot of snapshots) {
    const arsPerUnit = Number(snapshot.ars_per_unit);
    const arsPerUsd = Number(snapshot.ars_per_usd);
    if (!(arsPerUsd > 0) || !(arsPerUnit > 0)) continue;
    const list = table.get(snapshot.currency) ?? [];
    list.push({ period: snapshot.period.slice(0, 10), usdPerUnit: arsPerUnit / arsPerUsd });
    table.set(snapshot.currency, list);
  }
  for (const list of table.values()) list.sort((a, b) => a.period.localeCompare(b.period));
  return table;
}

/**
 * USD per unit of `currency` on `date` ("YYYY-MM-DD"): 1 for USD; otherwise
 * the snapshot of that month or the nearest earlier one. Null when there is
 * none.
 */
export function usdPerUnitOn(table: RateTable, currency: string, date: string): number | null {
  if (currency === "USD") return 1;
  const list = table.get(currency);
  if (!list || list.length === 0) return null;
  const month = `${date.slice(0, 7)}-01`;
  let found: number | null = null;
  for (const entry of list) {
    if (entry.period > month) break;
    found = entry.usdPerUnit;
  }
  return found;
}

/** `amount` in `from` expressed in `to` on `date`; null when a rate is missing. */
export function convertOn(
  table: RateTable,
  amount: number,
  from: string,
  to: string,
  date: string,
): number | null {
  if (from === to) return amount;
  const fromRate = usdPerUnitOn(table, from, date);
  const toRate = usdPerUnitOn(table, to, date);
  if (fromRate === null || toRate === null || toRate === 0) return null;
  return (amount * fromRate) / toRate;
}

export type MoneyItem = {
  amount: number;
  currency: string;
  /** The document's date ("YYYY-MM-DD"): picks the rate. */
  date: string;
  /** Units of the local currency per unit of `currency`, when the document stores it. */
  rateToLocal?: number | string | null;
};

export type CurrencySubtotal = { currency: string; amount: number; count: number };

export type MoneySummary = {
  localCurrency: string;
  /** Per currency, in that currency, sorted by currency code. */
  byCurrency: CurrencySubtotal[];
  /** Everything converted to the local currency (only what could be converted). */
  local: number;
  /** Everything converted to USD (only what could be converted). */
  usd: number;
  /** False when some amount had no rate to the local currency: `local` is short. */
  localComplete: boolean;
  /** False when some amount had no rate to USD: `usd` is short. */
  usdComplete: boolean;
};

export function emptySummary(localCurrency: string): MoneySummary {
  return { localCurrency, byCurrency: [], local: 0, usd: 0, localComplete: true, usdComplete: true };
}

function toLocal(item: MoneyItem, localCurrency: string, table: RateTable): number | null {
  if (item.currency === localCurrency) return item.amount;
  if (item.rateToLocal !== null && item.rateToLocal !== undefined && item.rateToLocal !== "") {
    const rate = Number(item.rateToLocal);
    if (Number.isFinite(rate) && rate > 0) return item.amount * rate;
  }
  return convertOn(table, item.amount, item.currency, localCurrency, item.date);
}

export function summarizeMoney(
  items: MoneyItem[],
  localCurrency: string,
  table: RateTable,
): MoneySummary {
  const summary = emptySummary(localCurrency);
  const subtotals = new Map<string, CurrencySubtotal>();

  for (const item of items) {
    if (!Number.isFinite(item.amount)) continue;
    const subtotal = subtotals.get(item.currency) ?? { currency: item.currency, amount: 0, count: 0 };
    subtotal.amount += item.amount;
    subtotal.count += 1;
    subtotals.set(item.currency, subtotal);

    const local = toLocal(item, localCurrency, table);
    if (local === null) summary.localComplete = false;
    else summary.local += local;

    const usd = convertOn(table, item.amount, item.currency, "USD", item.date);
    if (usd === null) summary.usdComplete = false;
    else summary.usd += usd;
  }

  summary.byCurrency = [...subtotals.values()].sort((a, b) => a.currency.localeCompare(b.currency));
  return summary;
}

/**
 * Adds (sign 1) or subtracts (sign -1) summaries already made, e.g. a margin
 * = sales - costs. Per-currency subtotals combine currency by currency; a
 * total is complete only if every part was.
 */
export function combineSummaries(
  localCurrency: string,
  parts: { summary: MoneySummary; sign?: 1 | -1 }[],
): MoneySummary {
  const result = emptySummary(localCurrency);
  const subtotals = new Map<string, CurrencySubtotal>();

  for (const { summary, sign = 1 } of parts) {
    result.local += sign * summary.local;
    result.usd += sign * summary.usd;
    result.localComplete &&= summary.localComplete;
    result.usdComplete &&= summary.usdComplete;
    for (const subtotal of summary.byCurrency) {
      const entry = subtotals.get(subtotal.currency) ?? { currency: subtotal.currency, amount: 0, count: 0 };
      entry.amount += sign * subtotal.amount;
      entry.count += subtotal.count;
      subtotals.set(subtotal.currency, entry);
    }
  }

  result.byCurrency = [...subtotals.values()].sort((a, b) => a.currency.localeCompare(b.currency));
  return result;
}

/** The same summary with every figure's sign flipped (credit notes shown as negatives). */
export function negateSummary(summary: MoneySummary): MoneySummary {
  return combineSummaries(summary.localCurrency, [{ summary, sign: -1 }]);
}

/** True when the summary has amounts in more than one currency, or in one other than the local. */
export function isMultiCurrency(summary: MoneySummary): boolean {
  return (
    summary.byCurrency.length > 1 ||
    (summary.byCurrency.length === 1 && summary.byCurrency[0].currency !== summary.localCurrency)
  );
}
