import type { CompanyConfig } from "@/lib/companyConfig";
import type { PaymentStatus } from "@/lib/dal";

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
