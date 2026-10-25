import { parseAmount } from "@/lib/amounts";

/**
 * Amounts and document type of a purchase-invoice row (costs import,
 * /companies/{id}/costs/import), with the rule of the Nubox sales import
 * (lib/nubox.ts, docs/cambios-flujo-v2.md 4.2): the net used for management
 * is Neto + Exento; IVA and Otros impuestos go apart, and
 * Neto + Exento + IVA + Otros must equal Total.
 *
 * A factura exenta (FAC-EE) or a 100% exempt credit note comes with Neto 0
 * and everything in Exento: it is a cost like any other, not a missing
 * amount. A credit note (N/C) subtracts: the amounts here are positive and
 * the database stores them negative (import_cost_rows_batch, 20261024050000).
 *
 * Every column but Neto is optional, so a generic CSV (no type, no exento,
 * no total) is read as before: an invoice of Neto + IVA. No database, no
 * Next.js imports: the Server Action and the preview both run it.
 */

export type PurchaseDocumentType = "invoice" | "credit_note";

/** A cell as the file has it: its header (for messages) and its text. null = column not mapped. */
export type PurchaseCell = { header: string; value: string | null | undefined } | null;

export type PurchaseRowCells = {
  net: PurchaseCell;
  exempt: PurchaseCell;
  tax: PurchaseCell;
  otherTaxes: PurchaseCell;
  total: PurchaseCell;
  documentType: PurchaseCell;
  documentNumber: PurchaseCell;
  status: PurchaseCell;
};

export type PurchaseAmounts = {
  documentType: PurchaseDocumentType;
  /** The file's own code, e.g. "FAC-EE"; null when the column is not mapped. */
  sourceDocumentType: string | null;
  documentNumber: string | null;
  /** Neto + Exento, positive (a credit note's sign is applied by the database). */
  netAmount: number;
  /** The exempt part of netAmount. */
  exemptAmount: number;
  taxAmount: number;
  otherTaxes: number;
  /** netAmount + taxAmount + otherTaxes: the total that is stored. */
  totalAmount: number;
};

export type PurchaseRowResult =
  | { amounts: PurchaseAmounts; error: null }
  | { amounts: null; error: string };

/**
 * How the file's Total relates to the amounts:
 * - "full": Total = Neto + Exento + IVA + Otros.
 * - "vat_withheld": factura de compra (FAC-CE), the buyer withholds the IVA,
 *   so Total is anywhere from Neto + Exento + Otros (all withheld) to the full sum.
 * - "withholding": boletas de honorarios / de terceros, Neto is the gross
 *   and Total what is paid after the retención (Total <= the full sum).
 * The cost is always the full amount: the IVA or retención withheld is still
 * paid, to the SII.
 */
type TotalRule = "full" | "vat_withheld" | "withholding";

const DOCUMENT_TYPES: Record<string, { type: PurchaseDocumentType; total: TotalRule; label: string }> = {
  "FAC-EL": { type: "invoice", total: "full", label: "factura" },
  "FAC-EE": { type: "invoice", total: "full", label: "factura exenta" },
  "FAC-CE": { type: "invoice", total: "vat_withheld", label: "factura de compra" },
  // A nota de débito raises the cost of the invoice it corrects.
  "N/D-EL": { type: "invoice", total: "full", label: "nota de débito" },
  "N/D-EE": { type: "invoice", total: "full", label: "nota de débito exenta" },
  "N/C-EL": { type: "credit_note", total: "full", label: "nota de crédito" },
  "N/C-EE": { type: "credit_note", total: "full", label: "nota de crédito exenta" },
  "BOL-HE": { type: "invoice", total: "withholding", label: "boleta de honorarios" },
  "BOL-TE": { type: "invoice", total: "withholding", label: "boleta de prestación de terceros" },
};

export const SUPPORTED_PURCHASE_DOCUMENT_TYPES = Object.keys(DOCUMENT_TYPES);

/** Nubox's "Estado" of a document that is not a purchase any more. */
const VOID_STATUS = /^(anulad|rechazad|reclamad)/i;

/** Nubox rounds each amount to the peso, so a total can be 1 off the sum. */
const ROUNDING_TOLERANCE = 1;

function amountOf(cell: PurchaseCell): { value: number; error: null } | { value: null; error: string } {
  if (!cell) return { value: 0, error: null };
  const parsed = parseAmount(cell.value);
  if (parsed.kind === "empty") return { value: 0, error: null };
  if (parsed.kind === "invalid") return { value: null, error: `${cell.header} inválido ${parsed.reason}` };
  return { value: parsed.value, error: null };
}

function shown(cell: PurchaseCell): string {
  return cell ? `${cell.header} "${(cell.value ?? "").trim() || "vacío"}"` : "";
}

function format(value: number): string {
  return String(Math.round(value * 100) / 100);
}

export function resolvePurchaseRow(cells: PurchaseRowCells): PurchaseRowResult {
  const fail = (error: string): PurchaseRowResult => ({ amounts: null, error });

  const status = cells.status?.value?.trim() ?? "";
  if (status && VOID_STATUS.test(status)) {
    return fail(`Documento con ${cells.status!.header} "${status}": no se importa`);
  }

  const rawType = cells.documentType?.value?.trim().toUpperCase() ?? "";
  let rule: (typeof DOCUMENT_TYPES)[string] = DOCUMENT_TYPES["FAC-EL"];
  if (cells.documentType) {
    const known = DOCUMENT_TYPES[rawType];
    if (!known) {
      return fail(
        `Tipo de documento no soportado: ${shown(cells.documentType)} (se importan ${SUPPORTED_PURCHASE_DOCUMENT_TYPES.join(", ")})`,
      );
    }
    rule = known;
  }
  const isCreditNote = rule.type === "credit_note";

  const parts = {
    net: amountOf(cells.net),
    exempt: amountOf(cells.exempt),
    tax: amountOf(cells.tax),
    otherTaxes: amountOf(cells.otherTaxes),
    total: amountOf(cells.total),
  };
  for (const part of Object.values(parts)) {
    if (part.error) return fail(part.error);
  }

  // Some exports write a credit note's amounts negative: same note.
  const values = Object.fromEntries(
    Object.entries(parts).map(([key, part]) => [key, part.value as number]),
  ) as Record<keyof typeof parts, number>;
  for (const key of Object.keys(values) as (keyof typeof parts)[]) {
    if (values[key] < 0) {
      if (!isCreditNote) {
        return fail(
          `${shown(cells[key])} es negativo: una nota de crédito se importa con su tipo de documento (N/C-EL)`,
        );
      }
      values[key] = -values[key];
    }
  }

  const netAmount = values.net + values.exempt;
  if (netAmount <= 0) {
    return fail(
      cells.exempt
        ? `${cells.net!.header} y ${cells.exempt.header} en 0 (${shown(cells.net)}, ${shown(cells.exempt)})`
        : `${shown(cells.net)}: falta el importe o es 0`,
    );
  }

  const fullSum = netAmount + values.tax + values.otherTaxes;

  if (cells.total && (cells.total.value ?? "").trim() !== "") {
    const total = values.total;
    const sumText = `${cells.net!.header}${cells.exempt ? ` + ${cells.exempt.header}` : ""}${cells.tax ? ` + ${cells.tax.header}` : ""}${cells.otherTaxes ? ` + ${cells.otherTaxes.header}` : ""}`;
    if (rule.total === "full" && Math.abs(fullSum - total) > ROUNDING_TOLERANCE) {
      return fail(
        `${shown(cells.total)} no cuadra con ${sumText} (${format(fullSum)}, diferencia ${format(total - fullSum)})`,
      );
    }
    if (
      rule.total === "vat_withheld" &&
      (total < fullSum - values.tax - ROUNDING_TOLERANCE || total > fullSum + ROUNDING_TOLERANCE)
    ) {
      return fail(
        `${shown(cells.total)} no cuadra con ${sumText} (${format(fullSum)}), ni con el IVA retenido (${format(fullSum - values.tax)})`,
      );
    }
    if (rule.total === "withholding" && (total <= 0 || total > fullSum + ROUNDING_TOLERANCE)) {
      return fail(
        `${shown(cells.total)} no cuadra con la ${rule.label}: el líquido debe ser mayor que 0 y no superar ${sumText} (${format(fullSum)})`,
      );
    }
  }

  const documentNumber = cells.documentNumber?.value?.trim() || null;

  return {
    error: null,
    amounts: {
      documentType: rule.type,
      sourceDocumentType: cells.documentType ? rawType : null,
      documentNumber,
      netAmount,
      exemptAmount: values.exempt,
      taxAmount: values.tax,
      otherTaxes: values.otherTaxes,
      totalAmount: fullSum,
    },
  };
}

/** Which header holds each amount (the costs import's column mapping). */
export type PurchaseColumnMapping = {
  amount: string;
  exempt: string | null;
  tax: string | null;
  otherTaxes: string | null;
  total: string | null;
  documentType: string | null;
  documentNumber: string | null;
  status: string | null;
};

export function purchaseRowCells(row: Record<string, string>, mapping: PurchaseColumnMapping): PurchaseRowCells {
  const cell = (header: string | null) => (header ? { header, value: row[header] } : null);
  return {
    net: cell(mapping.amount),
    exempt: cell(mapping.exempt),
    tax: cell(mapping.tax),
    otherTaxes: cell(mapping.otherTaxes),
    total: cell(mapping.total),
    documentType: cell(mapping.documentType),
    documentNumber: cell(mapping.documentNumber),
    status: cell(mapping.status),
  };
}

/** The document's signed total, as import_cost_rows_batch stores it. */
export function signedTotal(amounts: PurchaseAmounts): number {
  return amounts.documentType === "credit_note" ? -amounts.totalAmount : amounts.totalAmount;
}
