/**
 * Automatic allocation suggestions (pure, no database): which periods or
 * quote an imported invoice most likely pays for. What is billed rarely
 * matches the expected amount exactly (licenses, usage), so the rules go
 * from strict to loose, always within the document's client and currency:
 *
 * 1. exact          -- exactly one open period of the month, or one quote
 *                      balance, equals the net (rounding tolerance).
 * 2. single_period  -- the client has exactly one open period due that
 *                      month: the whole net goes there, whatever it is,
 *                      as long as it is between SINGLE_PERIOD_MIN_RATIO
 *                      and SINGLE_PERIOD_MAX_RATIO times what the period
 *                      expects (half to double).
 * 3. proportional   -- several open periods that month whose expected
 *                      amounts add up to the net within
 *                      SUGGESTION_SUM_TOLERANCE: the net is split in
 *                      proportion to them, the last line takes the rounding.
 * 4. quote          -- no open period that month, and exactly one quote
 *                      with an open balance of at least the net.
 * 5. otherwise nothing: the invoice stays in "Pendientes de conciliar".
 *
 * Documents are processed in date order and each suggestion counts for the
 * ones after it (a period suggested once is no longer "pending").
 */
import { currencyDecimals } from "@/lib/currencies";
import { amountTolerance } from "@/lib/salesAllocationsShared";

/** How far (±, a fraction of the net) the expected amounts of a month may add up to and still be split. */
export const SUGGESTION_SUM_TOLERANCE = 0.15;

/**
 * Rule 2 (the only period of the month) only suggests when the net is at
 * most this many times what the period still expects. Tested against prod
 * data: without a cap, invoices of a client's jobs (6.579.278 against a
 * period of 470.595) were suggested to its only recurring period.
 */
export const SINGLE_PERIOD_MAX_RATIO = 2;

/**
 * ...and at least this fraction of it. Tested against prod data: small
 * one-off sales to the client (30.000 against a period of 614.576) were
 * suggested to its only recurring period.
 */
export const SINGLE_PERIOD_MIN_RATIO = 0.5;

export type SuggestionReason = "exact" | "single_period" | "proportional" | "quote";

export const SUGGESTION_REASON_LABELS: Record<SuggestionReason, string> = {
  exact: "Monto exacto",
  single_period: "Único período del mes",
  proportional: "Reparto proporcional",
  quote: "Cotización con saldo",
};

export type SuggestionDocument = {
  id: string;
  clientId: string;
  currency: string;
  netAmount: number;
  /** "YYYY-MM-DD" */
  documentDate: string;
  documentNumber: string | null;
};

export type SuggestionPeriod = {
  id: string;
  clientId: string;
  currency: string;
  /** Due month ("YYYY-MM"), as on the board. */
  month: string;
  /** Expected amount of the period. */
  expected: number;
  /** Already allocated to it (confirmed + suggested), in its currency. */
  allocated: number;
  /** It has at least one allocation. */
  hasAllocations: boolean;
  /** Pending to invoice (no allocations) or with a balance left; never void, paid or marked by hand. */
  open: boolean;
};

export type SuggestionQuote = {
  id: string;
  clientId: string;
  /** The company's currency (jobs carry no currency of their own). */
  currency: string;
  /** Quoted amount minus what is already allocated; null = no quoted amount. */
  balance: number | null;
};

export type SuggestedAllocation = {
  documentId: string;
  targetType: "period" | "quote";
  targetId: string;
  amount: number;
  reason: SuggestionReason;
  /** What the destination was expected to take (period remaining / quote balance). */
  expected: number | null;
};

function round(value: number, currency: string): number {
  const factor = 10 ** currencyDecimals(currency);
  return Math.round(value * factor) / factor;
}

function remainingOf(period: SuggestionPeriod): number {
  return period.hasAllocations ? period.expected - period.allocated : period.expected;
}

/**
 * Periods of the document's client, currency and month that can still take
 * an invoice. A period already partly billed counts while something is left
 * (`material`: only while what is left is at least SUGGESTION_SUM_TOLERANCE
 * of its expected amount -- a leftover of a few percent is a price change,
 * not room for a second invoice).
 */
function openPeriodsFor(doc: SuggestionDocument, periods: SuggestionPeriod[], material: boolean): SuggestionPeriod[] {
  const month = doc.documentDate.slice(0, 7);
  const tolerance = amountTolerance(doc.currency);
  return periods.filter((period) => {
    if (!period.open || period.clientId !== doc.clientId || period.currency !== doc.currency || period.month !== month) {
      return false;
    }
    if (!period.hasAllocations) return true;
    const left = remainingOf(period);
    return left > (material ? Math.max(tolerance, SUGGESTION_SUM_TOLERANCE * period.expected) : tolerance);
  });
}

/**
 * Splits `net` in proportion to `weights` (all > 0): every share rounded to
 * the currency, the last one takes what rounding left so the sum is exact.
 */
export function splitProportionally(net: number, weights: number[], currency: string): number[] {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (weights.length === 0 || total <= 0) return [];
  const shares = weights.map((weight) => round((net * weight) / total, currency));
  const allButLast = shares.slice(0, -1).reduce((sum, share) => sum + share, 0);
  shares[shares.length - 1] = round(net - allButLast, currency);
  return shares;
}

/** The suggestion for one document, given the current state (not mutated). */
export function suggestForDocument(
  doc: SuggestionDocument,
  periods: SuggestionPeriod[],
  quotes: SuggestionQuote[],
): SuggestedAllocation[] {
  const tolerance = amountTolerance(doc.currency);
  const net = doc.netAmount;
  if (!(net > 0)) return [];

  const exactCandidates = openPeriodsFor(doc, periods, false);
  const candidates = openPeriodsFor(doc, periods, true);
  const clientQuotes = quotes.filter(
    (quote) => quote.clientId === doc.clientId && quote.currency === doc.currency && quote.balance !== null,
  );

  // 1. Exact.
  const exactPeriods = exactCandidates.filter((period) => Math.abs(remainingOf(period) - net) <= tolerance);
  const exactQuotes = clientQuotes.filter(
    (quote) => (quote.balance as number) > tolerance && Math.abs((quote.balance as number) - net) <= tolerance,
  );
  if (exactPeriods.length + exactQuotes.length === 1) {
    if (exactPeriods.length === 1) {
      const period = exactPeriods[0];
      return [
        { documentId: doc.id, targetType: "period", targetId: period.id, amount: net, reason: "exact", expected: remainingOf(period) },
      ];
    }
    const quote = exactQuotes[0];
    return [{ documentId: doc.id, targetType: "quote", targetId: quote.id, amount: net, reason: "exact", expected: quote.balance }];
  }

  // 2. The only period of the month, whatever the amount -- between
  //    SINGLE_PERIOD_MIN_RATIO and SINGLE_PERIOD_MAX_RATIO times what it
  //    expects.
  if (candidates.length === 1) {
    const period = candidates[0];
    const expected = remainingOf(period);
    if (net > SINGLE_PERIOD_MAX_RATIO * expected + tolerance) return [];
    if (net < SINGLE_PERIOD_MIN_RATIO * expected - tolerance) return [];
    return [
      { documentId: doc.id, targetType: "period", targetId: period.id, amount: net, reason: "single_period", expected: remainingOf(period) },
    ];
  }

  // 3. Several periods of the month that add up to the net (± tolerance).
  if (candidates.length > 1) {
    const weighted = candidates
      .map((period) => ({ period, weight: remainingOf(period) }))
      .filter((row) => row.weight > 0)
      // Smallest first: the largest line takes the rounding rest.
      .sort((a, b) => a.weight - b.weight || a.period.id.localeCompare(b.period.id));
    const sum = weighted.reduce((total, row) => total + row.weight, 0);
    if (weighted.length === 0 || Math.abs(sum - net) > SUGGESTION_SUM_TOLERANCE * net) return [];
    const shares = splitProportionally(
      net,
      weighted.map((row) => row.weight),
      doc.currency,
    );
    return weighted
      .map((row, index) => ({
        documentId: doc.id,
        targetType: "period" as const,
        targetId: row.period.id,
        amount: shares[index],
        reason: "proportional" as const,
        expected: row.weight,
      }))
      .filter((row) => row.amount > 0);
  }

  // 4. No period that month: the one quote whose balance covers the net.
  const covering = clientQuotes.filter((quote) => (quote.balance as number) >= net - tolerance);
  if (covering.length === 1) {
    const quote = covering[0];
    return [{ documentId: doc.id, targetType: "quote", targetId: quote.id, amount: net, reason: "quote", expected: quote.balance }];
  }

  // 5. Nothing to suggest.
  return [];
}

/**
 * Suggestions for a batch of documents, in date (then number) order; each
 * one updates the periods' and quotes' state for the next.
 */
export function suggestAllocationsFor(
  documents: SuggestionDocument[],
  periods: SuggestionPeriod[],
  quotes: SuggestionQuote[],
): SuggestedAllocation[] {
  const periodState = periods.map((period) => ({ ...period }));
  const quoteState = quotes.map((quote) => ({ ...quote }));
  const result: SuggestedAllocation[] = [];

  const ordered = [...documents].sort(
    (a, b) =>
      a.documentDate.localeCompare(b.documentDate) ||
      (a.documentNumber ?? "").localeCompare(b.documentNumber ?? "", "es", { numeric: true }) ||
      a.id.localeCompare(b.id),
  );

  for (const doc of ordered) {
    const suggestions = suggestForDocument(doc, periodState, quoteState);
    for (const suggestion of suggestions) {
      if (suggestion.targetType === "period") {
        const period = periodState.find((p) => p.id === suggestion.targetId)!;
        period.allocated = (period.hasAllocations ? period.allocated : 0) + suggestion.amount;
        period.hasAllocations = true;
      } else {
        const quote = quoteState.find((q) => q.id === suggestion.targetId)!;
        quote.balance = (quote.balance ?? 0) - suggestion.amount;
      }
    }
    result.push(...suggestions);
  }

  return result;
}
