import { parseAmount } from "@/lib/amounts";
import { currencyDecimals, decimalsReason, tooManyDecimals } from "@/lib/currencies";
import { parseSaleTaxCell, type AmountBasis } from "@/lib/genericImport";

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
 * no total) is read as before: an invoice of Neto + IVA. A file that brings
 * only the total with IVA included maps it with the "total_with_tax" basis,
 * and the net and IVA are derived from it (the company's rate). No database, no
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
  /**
   * Boletas: the retención, gross - what the file's Total says is paid (the
   * líquido). Null when it is not a boleta, or the file has no Total: the
   * database then uses the rate of its year (boleta_withholding_rates).
   */
  withholdingAmount: number | null;
  /** Only with the total-with-IVA basis: true when the IVA came from the company's rate. */
  taxComputed?: boolean;
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

/**
 * Plain words other exports use for the type (e.g. the Uruguayan purchases
 * export writes "Factura"), read as the code they mean.
 */
const DOCUMENT_TYPE_WORDS: Record<string, string> = {
  FACTURA: "FAC-EL",
  "E-FACTURA": "FAC-EL",
  EFACTURA: "FAC-EL",
  "FACTURA ELECTRONICA": "FAC-EL",
  "FACTURA EXENTA": "FAC-EE",
  "NOTA DE CREDITO": "N/C-EL",
  "NOTA CREDITO": "N/C-EL",
  "NOTA DE DEBITO": "N/D-EL",
  "NOTA DEBITO": "N/D-EL",
};

/** "FAC-EL" as is; "Factura", "Nota de crédito" -> their code; unknown -> the text, upper case. */
function documentTypeCode(raw: string): string {
  const text = raw.trim().toUpperCase();
  if (DOCUMENT_TYPES[text]) return text;
  const words = text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\s+/g, " ");
  return DOCUMENT_TYPE_WORDS[words] ?? text;
}

/**
 * How the amount column is read: the net (Neto, the IVA in its own column),
 * or the total with IVA included, split into net and IVA with the company's
 * rate (lib/genericImport.ts, same rule as the sales import).
 */
export type PurchaseAmountOptions = {
  basis?: AmountBasis;
  vatRate?: number | null;
  /** The row's currency, for rounding; null when it could not be read. */
  currency?: string | null;
};

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

export function resolvePurchaseRow(cells: PurchaseRowCells, options: PurchaseAmountOptions = {}): PurchaseRowResult {
  const fail = (error: string): PurchaseRowResult => ({ amounts: null, error });
  const totalBasis = options.basis === "total_with_tax";

  const status = cells.status?.value?.trim() ?? "";
  if (status && VOID_STATUS.test(status)) {
    return fail(`Documento con ${cells.status!.header} "${status}": no se importa`);
  }

  const rawType = documentTypeCode(cells.documentType?.value ?? "");
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

  if (totalBasis) {
    if (cells.total) {
      return fail(`${cells.net?.header} es el total con IVA incluido: no mapees también ${cells.total.header} (elegí uno)`);
    }
    if (rule.total !== "full") {
      return fail(
        `Una ${rule.label} no se puede importar desde el total con IVA incluido: mapeá el Neto (bruto) y el Total`,
      );
    }
  }

  // With the total basis, an IVA cell may say the row is exempt ("Exento").
  const taxCell = cells.tax ? parseSaleTaxCell(cells.tax.value) : { kind: "empty" as const };
  const exemptRow = totalBasis && taxCell.kind === "exempt";

  const parts = {
    net: amountOf(cells.net),
    exempt: amountOf(cells.exempt),
    tax: exemptRow ? { value: 0, error: null } : amountOf(cells.tax),
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

  // CLP in whole pesos, USD/UYU with at most 2 decimals (audit 2026-11, M-09).
  const factor = 10 ** currencyDecimals(options.currency ?? "");
  const round = (value: number) => Math.round(value * factor) / factor;
  for (const key of Object.keys(values) as (keyof typeof parts)[]) {
    if (tooManyDecimals(values[key], factor)) {
      return fail(`${cells[key]?.header ?? key}: ${decimalsReason(values[key], options.currency)}`);
    }
  }

  // The amount column holds the total with IVA: split it. The taxable part
  // is the total minus Exento and Otros impuestos (when mapped); its IVA is
  // the row's own (0 or "exento": net = total) or the company's rate.
  let taxComputed = false;
  const fileTotal = values.net;
  if (totalBasis) {
    const taxable = round(values.net - values.exempt - values.otherTaxes);
    if (values.net <= 0) return fail(`${shown(cells.net)}: falta el importe o es 0`);
    if (taxable < 0) {
      return fail(`${shown(cells.net)} es menor que el exento y los otros impuestos de la fila`);
    }
    const rowHasTax = exemptRow || taxCell.kind === "ok";
    if (rowHasTax) {
      if (values.tax > taxable) {
        return fail(`${shown(cells.tax)} es mayor que el total con IVA (${format(taxable)} sin exento ni otros impuestos)`);
      }
      values.net = round(taxable - values.tax);
    } else {
      if (options.vatRate === null || options.vatRate === undefined) {
        return fail("la empresa no tiene una tasa de IVA definida (país desconocido): mapeá el neto o la columna de IVA");
      }
      values.net = round(taxable / (1 + options.vatRate));
      values.tax = round(taxable - values.net);
      taxComputed = true;
    }
  }

  // Rounded to the currency: in floating point 0.1 + 0.2 is 0.30000000000000004,
  // which numeric would store as is (audit 2026-11, M-09).
  const netAmount = round(values.net + values.exempt);
  if (netAmount <= 0) {
    return fail(
      cells.exempt
        ? `${cells.net!.header} y ${cells.exempt.header} en 0 (${shown(cells.net)}, ${shown(cells.exempt)})`
        : `${shown(cells.net)}: falta el importe o es 0`,
    );
  }

  const fullSum = round(netAmount + values.tax + values.otherTaxes);
  const hasTotal = Boolean(cells.total && (cells.total.value ?? "").trim() !== "");

  if (hasTotal && cells.total) {
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
      // With the total basis, net + IVA (+ exento + otros) is the file's total.
      totalAmount: totalBasis ? fileTotal : fullSum,
      withholdingAmount: rule.total === "withholding" && hasTotal ? Math.max(0, round(netAmount - values.total)) : null,
      ...(totalBasis ? { taxComputed } : {}),
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
