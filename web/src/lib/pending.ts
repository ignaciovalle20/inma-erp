/**
 * Rules of the Pendientes screen (docs/plan-sistema-v3.md, B1 and B2). Pure,
 * so they can be tested without a database.
 */

/** An invoice Nubox reports as overdue for longer than this is worth checking by hand. */
export const STALE_OVERDUE_DAYS = 60;

const DAY_MS = 86_400_000;

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * The due date before which an overdue invoice counts as "revisar cobro":
 * more than STALE_OVERDUE_DAYS days ago. Calendar days in UTC, like every
 * other date in the app.
 */
export function staleDueCutoff(today: Date, days: number = STALE_OVERDUE_DAYS): string {
  const utcMidnight = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return toIsoDate(new Date(utcMidnight - days * DAY_MS));
}

/** Is this document older than the date the company starts managing from? */
export function isOutsideManagement(documentDate: string, startDate: string | null): boolean {
  return startDate !== null && documentDate < startDate;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Reads the date field of the company form: empty means "no limit" (null);
 * anything else must be a real calendar date (2026-02-30 is not).
 */
export function parseManagementStartDate(
  input: FormDataEntryValue | null | undefined,
): { ok: true; value: string | null } | { ok: false } {
  if (input === null || input === undefined) return { ok: true, value: null };
  if (typeof input !== "string") return { ok: false };

  const trimmed = input.trim();
  if (trimmed === "") return { ok: true, value: null };
  if (!DATE_PATTERN.test(trimmed)) return { ok: false };

  const date = new Date(`${trimmed}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || toIsoDate(date) !== trimmed) return { ok: false };

  return { ok: true, value: trimmed };
}
