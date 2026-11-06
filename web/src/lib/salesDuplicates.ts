/**
 * Possible duplicates in the generic sales import, the rule the database
 * applies in import_sales_rows_batch (migration 20261106030721): the preview
 * shows the same "Posible duplicado" the commit will record.
 *
 * A folio may be stored with its series ("A-13791", the first Uruguayan load)
 * and arrive without it ("13791", the invoicing export): same invoice. So a
 * row whose folio is not found exactly is still a possible duplicate when the
 * same client has a non-voided document with
 *  - the same folio number and series, or no series on one side, or
 *  - no folio, on the same date and for the same total.
 * A row without a folio keeps the old rule: same client, date and total.
 */

/** Digits of a folio without leading zeros ("A-013791" -> "13791"); null when none. */
export function folioNumber(folio: string | null | undefined): string | null {
  const digits = (folio ?? "").replace(/[^0-9]/g, "").replace(/^0+/, "");
  return digits || null;
}

/** Letters of a folio, upper case ("a-13791" -> "A"); "" when none. */
export function folioSeries(folio: string | null | undefined): string {
  return (folio ?? "").replace(/[^A-Za-z]/g, "").toUpperCase();
}

/** "13791" and "A-13791" are the same folio; "A-13791" and "B-13791" are not. */
export function sameFolio(a: string | null | undefined, b: string | null | undefined): boolean {
  const number = folioNumber(a);
  if (!number || number !== folioNumber(b)) return false;
  const seriesA = folioSeries(a);
  const seriesB = folioSeries(b);
  return seriesA === "" || seriesB === "" || seriesA === seriesB;
}

export type ExistingSale = {
  client_id: string;
  document_date: string;
  total_amount: number;
  document_number: string | null;
};

const round2 = (value: number) => Math.round(value * 100) / 100;

/**
 * The existing document a row may duplicate, or null. Exact folio matches
 * are handled apart (the folio already exists: never imported again).
 */
export function findPossibleDuplicate(
  row: { clientId: string; date: string; total: number; documentNumber: string | null },
  existing: ExistingSale[],
): ExistingSale | null {
  const total = round2(row.total);
  const sameDayAndTotal = (doc: ExistingSale) =>
    doc.document_date === row.date && round2(doc.total_amount) === total;

  return (
    existing.find((doc) => {
      if (doc.client_id !== row.clientId) return false;
      if (!row.documentNumber) return sameDayAndTotal(doc);
      return sameFolio(row.documentNumber, doc.document_number) || (!doc.document_number && sameDayAndTotal(doc));
    }) ?? null
  );
}
