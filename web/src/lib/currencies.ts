export const CURRENCIES = ["CLP", "UYU", "USD"] as const;

export type Currency = (typeof CURRENCIES)[number];

/** CLP has no decimals; UYU, USD and the rest show two. */
export function currencyDecimals(currency: string): number {
  return currency === "CLP" ? 0 : 2;
}
