/**
 * Automatic allocation of purchase invoices (cost_documents) to recurring
 * service cost periods -- pure, no database; the model of
 * allocationSuggestions.ts for sales. Candidates always share supplier,
 * month (the document's recognized period, else its date) and currency;
 * documents without any allocation, periods without any invoice.
 *
 * Rules, in order, within each (supplier, month, currency):
 * 1. exact             -- one document whose net equals the expected amount
 *                         of one single period: confirmed.
 * 2. same_amount_batch -- N documents and M periods of the same amount
 *                         (4 equal Starlink invoices, 4 services): paired
 *                         in a stable order (documents by date then id,
 *                         periods by service name then id), confirmed; what
 *                         does not pair stays unallocated (no suggestion).
 * 3. proportional      -- a document whose net equals the sum of the
 *                         expected amounts of all the periods still open
 *                         (one server shared by several hostings): split in
 *                         proportion with the largest-remainder rounding of
 *                         20261004010000, confirmed. When it does not add up
 *                         but it is the supplier's only document that month,
 *                         the same split is left as a suggestion.
 * 4. anything else stays unallocated.
 */
import { currencyDecimals } from "@/lib/currencies";

export type CostSuggestionReason = "exact" | "same_amount_batch" | "proportional";

export const COST_SUGGESTION_REASON_LABELS: Record<CostSuggestionReason, string> = {
  exact: "Monto exacto",
  same_amount_batch: "Lote del mismo monto",
  proportional: "Reparto proporcional",
};

export type CostCandidateDocument = {
  id: string;
  supplierId: string;
  currency: string;
  netAmount: number;
  /** "YYYY-MM": recognized period, else the document's date. */
  month: string;
  /** "YYYY-MM-DD", for the stable order. */
  documentDate: string;
};

export type CostCandidatePeriod = {
  id: string;
  supplierId: string;
  currency: string;
  /** "YYYY-MM" */
  month: string;
  expected: number;
  serviceName: string;
};

export type CostAllocationProposal = {
  documentId: string;
  costPeriodId: string;
  amount: number;
  status: "confirmed" | "suggested";
  reason: CostSuggestionReason;
};

/** An amount in the currency's smallest unit (pesos, cents). */
function units(value: number, currency: string): number {
  return Math.round(value * 10 ** currencyDecimals(currency));
}

/**
 * Splits `net` among `weights` in proportion, by largest remainder: every
 * share a whole unit of the currency, the sum exactly `net`. Weights all
 * zero split equally. Same tie-breaking as the MS pool split (positive
 * weight first, larger fraction, larger weight, then input order).
 */
export function splitByLargestRemainder(net: number, weights: number[], currency: string): number[] {
  if (weights.length === 0) return [];
  const scale = 10 ** currencyDecimals(currency);
  const totalUnits = units(net, currency);
  const effective = weights.every((w) => w <= 0) ? weights.map(() => 1) : weights.map((w) => Math.max(w, 0));
  const totalWeight = effective.reduce((sum, w) => sum + w, 0);

  const rows = effective.map((weight, index) => {
    const exact = (totalUnits * weight) / totalWeight;
    const base = Math.floor(exact);
    return { index, weight, base, fraction: exact - base };
  });
  let leftover = totalUnits - rows.reduce((sum, row) => sum + row.base, 0);
  const ranked = [...rows].sort(
    (a, b) =>
      Number(b.weight > 0) - Number(a.weight > 0) || b.fraction - a.fraction || b.weight - a.weight || a.index - b.index,
  );
  for (const row of ranked) {
    if (leftover <= 0) break;
    if (row.weight <= 0) continue;
    row.base += 1;
    leftover -= 1;
  }
  return rows.map((row) => row.base / scale);
}

const byDocumentOrder = (a: CostCandidateDocument, b: CostCandidateDocument) =>
  a.documentDate.localeCompare(b.documentDate) || a.id.localeCompare(b.id);

const byPeriodOrder = (a: CostCandidatePeriod, b: CostCandidatePeriod) =>
  a.serviceName.localeCompare(b.serviceName, "es") || a.id.localeCompare(b.id);

function groupKey(item: { supplierId: string; month: string; currency: string }): string {
  return `${item.supplierId}|${item.month}|${item.currency}`;
}

/** The proposals for one (supplier, month, currency) group. */
function proposeForGroup(
  documents: CostCandidateDocument[],
  periods: CostCandidatePeriod[],
): CostAllocationProposal[] {
  const proposals: CostAllocationProposal[] = [];
  if (documents.length === 0 || periods.length === 0) return proposals;
  const currency = documents[0].currency;

  const openDocuments = [...documents].sort(byDocumentOrder);
  const openPeriods = [...periods].sort(byPeriodOrder);
  const used = new Set<string>();

  // 1 + 2. Same amount: one and one is exact; more is a batch.
  const amounts = new Set(openDocuments.map((doc) => units(doc.netAmount, currency)));
  for (const amount of amounts) {
    const docs = openDocuments.filter((doc) => !used.has(doc.id) && units(doc.netAmount, currency) === amount);
    const matches = openPeriods.filter((period) => !used.has(period.id) && units(period.expected, currency) === amount);
    if (docs.length === 0 || matches.length === 0) continue;
    const reason: CostSuggestionReason = docs.length === 1 && matches.length === 1 ? "exact" : "same_amount_batch";
    const pairs = Math.min(docs.length, matches.length);
    for (let i = 0; i < pairs; i += 1) {
      proposals.push({
        documentId: docs[i].id,
        costPeriodId: matches[i].id,
        amount: docs[i].netAmount,
        status: "confirmed",
        reason,
      });
      used.add(docs[i].id);
      used.add(matches[i].id);
    }
  }

  // 3. One document for every period left.
  const remainingDocs = openDocuments.filter((doc) => !used.has(doc.id));
  const remainingPeriods = openPeriods.filter((period) => !used.has(period.id));
  if (remainingDocs.length === 0 || remainingPeriods.length === 0) return proposals;

  const expectedSum = remainingPeriods.reduce((sum, period) => sum + units(period.expected, currency), 0);
  const covering = remainingDocs.find((doc) => units(doc.netAmount, currency) === expectedSum && expectedSum > 0);
  const onlyDocumentOfTheMonth = documents.length === 1 ? remainingDocs[0] : null;
  const target = covering ?? onlyDocumentOfTheMonth;
  if (!target) return proposals;

  const shares = splitByLargestRemainder(
    target.netAmount,
    remainingPeriods.map((period) => period.expected),
    currency,
  );
  remainingPeriods.forEach((period, index) => {
    if (shares[index] <= 0) return;
    proposals.push({
      documentId: target.id,
      costPeriodId: period.id,
      amount: shares[index],
      status: covering ? "confirmed" : "suggested",
      reason: "proportional",
    });
  });
  return proposals;
}

/** Every proposal for the given candidates (only matching groups pair up). */
export function proposeCostAllocations(
  documents: CostCandidateDocument[],
  periods: CostCandidatePeriod[],
): CostAllocationProposal[] {
  const docsByGroup = new Map<string, CostCandidateDocument[]>();
  for (const doc of documents) {
    if (!(doc.netAmount > 0)) continue;
    const key = groupKey(doc);
    docsByGroup.set(key, [...(docsByGroup.get(key) ?? []), doc]);
  }
  const periodsByGroup = new Map<string, CostCandidatePeriod[]>();
  for (const period of periods) {
    const key = groupKey(period);
    periodsByGroup.set(key, [...(periodsByGroup.get(key) ?? []), period]);
  }

  const proposals: CostAllocationProposal[] = [];
  for (const key of [...docsByGroup.keys()].sort()) {
    proposals.push(...proposeForGroup(docsByGroup.get(key) ?? [], periodsByGroup.get(key) ?? []));
  }
  return proposals;
}
