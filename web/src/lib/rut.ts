/**
 * The one normalization of a Chilean RUT: no dots or spaces, hyphen before the
 * check digit, check digit in upper case, no leading zeros. Same formula as
 * normalize_tax_id in SQL (20261031020000), which is what the database keeps
 * and compares. The check digit is not validated: a RUT is compared, never
 * checked against the SII.
 */

/** "12.345.678-k" / "012345678K" -> "12345678-K"; null when it is not a RUT. */
export function normalizeRut(input: string | null | undefined): string | null {
  const compact = (input ?? "").replace(/[^0-9A-Za-z]/g, "").toUpperCase();
  const match = compact.match(/^(\d+)([\dK])$/);
  if (!match) return null;
  const body = match[1].replace(/^0+/, "");
  if (body.length < 6 || body.length > 9) return null;
  return `${body}-${match[2]}`;
}

/**
 * What is stored as a tax id: the normalized RUT, or the trimmed text when it
 * is not a RUT (a foreign supplier's id stays as it was typed).
 */
export function taxIdForStorage(input: string | null | undefined): string | null {
  return normalizeRut(input) ?? (input?.trim() || null);
}

/** Two tax ids are the same one when their normalized form is. Empty never matches. */
export function sameTaxId(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = taxIdForStorage(a);
  return left !== null && left === taxIdForStorage(b);
}
