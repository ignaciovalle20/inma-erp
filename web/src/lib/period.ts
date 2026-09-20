/** Formats a "YYYY-MM-01" period date as "septiembre de 2026". */
export function formatPeriod(period: string): string {
  const date = new Date(`${period}T00:00:00Z`);
  return date.toLocaleDateString("es-ES", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * A month as the app passes it around ("YYYY-MM"): the month must be 01-12.
 * Validating only the shape let "2026-13" through, which then became an
 * invalid date and crashed every month screen.
 */
export const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

export function isValidMonth(value: unknown): value is string {
  return typeof value === "string" && MONTH_PATTERN.test(value);
}
