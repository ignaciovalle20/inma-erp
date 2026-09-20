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

const MONTH_NAMES = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
];

/** "2026-09" -> "septiembre 2026". */
export function monthLabel(period: string): string {
  const [year, month] = period.split("-").map(Number);
  return `${MONTH_NAMES[month - 1]} ${year}`;
}

/** "YYYY-MM" of the current month (UTC, like every other date in the app). */
export function currentMonth(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * The month a list screen shows. With years of history loaded, "everything at
 * once" is not a useful first screen (and its totals read as one giant
 * month), so a page opened without a period shows the current month.
 * period=all (or an empty month field) is the whole history; an explicit
 * from/to range, as the report drill-downs pass, is left alone.
 */
export function resolvePeriod(params: { period?: string; from?: string; to?: string }): string | null {
  if (params.period === undefined) {
    return params.from || params.to ? null : currentMonth();
  }
  return MONTH_PATTERN.test(params.period) ? params.period : null;
}

/** "YYYY-MM" shifted by a number of months. */
export function shiftMonth(period: string, delta: number): string {
  const [year, month] = period.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1 + delta, 1));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}`;
}
