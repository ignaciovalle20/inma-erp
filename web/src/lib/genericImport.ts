import type { CompanyConfig } from "@/lib/companyConfig";
import type { PaymentStatus } from "@/lib/dal";
import { parseAmount, type AmountResult } from "@/lib/amounts";
import { currencyDecimals } from "@/lib/currencies";

/**
 * Pure rules of the generic importers (sales and costs from any CSV/Excel
 * whose columns the user maps): how a currency cell and a payment status
 * cell are read. Shared by the preview (client) and the commit (server) so
 * both say the same thing about every row.
 */

const CURRENCY_ALIASES: Record<string, string> = {
  USD: "USD",
  "US$": "USD",
  U$S: "USD",
  "U$": "USD",
  DOLAR: "USD",
  DOLARES: "USD",
  UYU: "UYU",
  $U: "UYU",
  UY$: "UYU",
  "PESO URUGUAYO": "UYU",
  "PESOS URUGUAYOS": "UYU",
  CLP: "CLP",
  "CL$": "CLP",
  "PESO CHILENO": "CLP",
  "PESOS CHILENOS": "CLP",
};

function plain(raw: string): string {
  return raw
    .trim()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toUpperCase()
    .replace(/\s+/g, " ");
}

export type CellResult<T> = { kind: "empty" } | { kind: "ok"; value: T } | { kind: "invalid"; reason: string };

/** "US$", "dólares", "usd" -> USD; "$" alone is ambiguous and rejected. */
export function parseCurrencyCell(raw: string | null | undefined): CellResult<string> {
  const text = plain(raw ?? "");
  if (!text) return { kind: "empty" };
  const currency = CURRENCY_ALIASES[text];
  return currency
    ? { kind: "ok", value: currency }
    : { kind: "invalid", reason: `moneda "${(raw ?? "").trim()}" no reconocida (USD, UYU o CLP)` };
}

/**
 * The currency of a row: the company's only currency when it has one (a
 * file that says otherwise is an error, never silently re-labelled); else
 * the row's own currency cell, or the currency chosen for the whole file.
 */
export function resolveRowCurrency(
  config: CompanyConfig,
  cell: string | null | undefined,
  fileCurrency: string | null,
): CellResult<string> {
  const parsed = parseCurrencyCell(cell);
  if (parsed.kind === "invalid") return parsed;

  if (config.fixedCurrency) {
    if (parsed.kind === "ok" && parsed.value !== config.fixedCurrency) {
      return { kind: "invalid", reason: `esta empresa solo usa ${config.fixedCurrency} (la fila dice ${parsed.value})` };
    }
    return { kind: "ok", value: config.fixedCurrency };
  }

  const currency = parsed.kind === "ok" ? parsed.value : fileCurrency;
  if (!currency) return { kind: "invalid", reason: "falta la moneda (mapeá la columna o elegí la del archivo)" };
  if (!config.documentCurrencies.includes(currency)) {
    return {
      kind: "invalid",
      reason: `moneda ${currency} no permitida en esta empresa (${config.documentCurrencies.join(" o ")})`,
    };
  }
  return { kind: "ok", value: currency };
}

/**
 * What the mapped amount column holds: the net (the IVA, if any, in its own
 * column) or the total with IVA included, which is split into net and IVA
 * with the company's rate. One column, one meaning: a file can't map both a
 * net and a total, so there is never a question of which one wins.
 */
export type AmountBasis = "net" | "total_with_tax";

const EXEMPT_WORDS = new Set(["EXENTO", "EXENTA", "EXE", "E", "N/A", "NA", "NO APLICA", "SIN IVA"]);

/**
 * The IVA cell: a number, empty, or a word saying the row is exempt
 * ("Exento", "exenta", "sin IVA"), which is an IVA of 0.
 */
export function parseSaleTaxCell(raw: string | null | undefined): AmountResult | { kind: "exempt" } {
  if (EXEMPT_WORDS.has(plain(raw ?? ""))) return { kind: "exempt" };
  return parseAmount(raw);
}

export type SaleAmounts = {
  /** What is stored as the amount: never includes IVA. */
  net: number;
  tax: number;
  total: number;
  /** True when the IVA came from the company's rate, not from the file. */
  taxComputed: boolean;
};

/**
 * The net, IVA and total of a sales row, the same in the preview and the
 * commit. With a net column: net as read, IVA from its column (empty = 0).
 * With a total-with-IVA column: when the row has an IVA (or says it is exempt,
 * or 0) net = total - IVA; otherwise the total is split with the company's
 * rate (Uruguay 22 %, Chile 19 %), rounded to the currency's decimals so that
 * net + IVA is exactly the total. "empty" when the amount cell is empty.
 */
export function resolveSaleAmounts(input: {
  basis: AmountBasis;
  amountCell: string | null | undefined;
  /** null when no IVA column is mapped. */
  taxCell: string | null | undefined;
  vatRate: number | null;
  /** The row's currency (for rounding); null when it could not be read. */
  currency: string | null;
}): { kind: "empty" } | { kind: "ok"; value: SaleAmounts } | { kind: "invalid"; reason: string } {
  const amount = parseAmount(input.amountCell);
  if (amount.kind === "empty") return amount;
  if (amount.kind === "invalid") return { kind: "invalid", reason: `Importe inválido ${amount.reason}` };

  const taxParsed = parseSaleTaxCell(input.taxCell);
  if (taxParsed.kind === "invalid") return { kind: "invalid", reason: `IVA inválido ${taxParsed.reason}` };
  const fileTax = taxParsed.kind === "ok" ? taxParsed.value : taxParsed.kind === "exempt" ? 0 : null;

  const factor = 10 ** currencyDecimals(input.currency ?? "");
  const round = (value: number) => Math.round(value * factor) / factor;

  if (input.basis === "net") {
    const tax = fileTax ?? 0;
    return { kind: "ok", value: { net: amount.value, tax, total: round(amount.value + tax), taxComputed: false } };
  }

  const total = amount.value;
  if (fileTax !== null) {
    if (Math.abs(fileTax) > Math.abs(total)) {
      return { kind: "invalid", reason: `el IVA (${fileTax}) es mayor que el total con IVA (${total})` };
    }
    return { kind: "ok", value: { net: round(total - fileTax), tax: fileTax, total, taxComputed: false } };
  }

  if (input.vatRate === null) {
    return {
      kind: "invalid",
      reason: "la empresa no tiene una tasa de IVA definida (país desconocido): mapeá el neto o la columna de IVA",
    };
  }
  const net = round(total / (1 + input.vatRate));
  return { kind: "ok", value: { net, tax: round(total - net), total, taxComputed: true } };
}

const PAID = new Set(["PAGADO", "PAGADA", "PAGO", "PAID", "COBRADO", "COBRADA", "SI", "S", "YES", "Y", "1", "TRUE", "VERDADERO", "BALANCED", "SALDADA", "SALDADO", "CANCELADA", "CANCELADO"]);
const UNPAID = new Set(["IMPAGO", "IMPAGA", "NO PAGADO", "NO PAGADA", "UNPAID", "PENDIENTE", "POR COBRAR", "NO", "N", "0", "FALSE", "FALSO", "VENCIDO", "VENCIDA", "POR VENCER", "EXPIRED", "TO_EXPIRE", "TO EXPIRE"]);

/** "Pagada", "sí", "cobrado" -> pagado; "pendiente", "no", "vencida" -> impago. */
export function parsePaymentStatusCell(raw: string | null | undefined): CellResult<PaymentStatus> {
  const text = plain(raw ?? "");
  if (!text) return { kind: "empty" };
  if (PAID.has(text)) return { kind: "ok", value: "pagado" };
  if (UNPAID.has(text)) return { kind: "ok", value: "impago" };
  return { kind: "invalid", reason: `estado de pago "${(raw ?? "").trim()}" no reconocido (pagada / impaga)` };
}
