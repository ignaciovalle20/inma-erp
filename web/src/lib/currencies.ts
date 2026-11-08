export const CURRENCIES = ["CLP", "UYU", "USD"] as const;

export type Currency = (typeof CURRENCIES)[number];

/** CLP has no decimals; UYU, USD and the rest show two. */
export function currencyDecimals(currency: string): number {
  return currency === "CLP" ? 0 : 2;
}

/** `value` rounded to the currency's decimals (whole pesos for CLP, cents otherwise). */
export function roundToCurrency(value: number, currency: string | null | undefined): number {
  const factor = 10 ** currencyDecimals(currency ?? "");
  return Math.round(value * factor) / factor;
}

/**
 * True when `value` has more decimals than `factor` (10 ** decimals) allows:
 * 1234.5 in CLP (factor 1), 10.125 in USD (factor 100). A float error of the
 * size of 1e-6 units is not a decimal (0.1 + 0.2).
 */
export function tooManyDecimals(value: number, factor: number): boolean {
  const scaled = value * factor;
  return Math.abs(scaled - Math.round(scaled)) > 1e-6;
}

/** The importers' message for an amount with more decimals than its currency takes. */
export function decimalsReason(value: number, currency: string | null | undefined): string {
  return currency === "CLP"
    ? `el importe ${value} tiene decimales: en CLP los montos van en pesos enteros`
    : `el importe ${value} tiene más de 2 decimales`;
}
