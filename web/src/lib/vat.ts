/**
 * IVA by company country. Used where a screen asks for a net amount and
 * shows the total with IVA only as a reference (the MS licenses pool:
 * docs/verificacion-contable-2026-10-04.md, point 2) -- every report adds
 * net amounts, never this total.
 */
const VAT_RATES: Record<string, number> = { CL: 0.19, UY: 0.22 };

/** 0.19 for Chile, 0.22 for Uruguay; null for any other country (never guessed). */
export function vatRateFor(country: string | null | undefined): number | null {
  return VAT_RATES[(country ?? "").toUpperCase()] ?? null;
}

/**
 * The net plus the country's IVA, rounded to the currency's decimals; null
 * when the net is not a positive number or the country has no known rate.
 */
export function totalWithVat(
  net: number,
  country: string | null | undefined,
  decimals: number,
): { rate: number; vat: number; total: number } | null {
  const rate = vatRateFor(country);
  if (rate === null || !Number.isFinite(net) || net <= 0) return null;
  const round = (value: number) => Number(value.toFixed(decimals));
  const vat = round(net * rate);
  return { rate, vat, total: round(net + vat) };
}
