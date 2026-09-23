/**
 * Pure helpers behind the recurring-services "Pendientes" screen and the
 * service list's badges (plan-servicios-recurrentes.md, Phase 5) -- kept
 * out of the pages so they can be unit-tested without rendering.
 */
import {
  SERVICE_TYPES,
  SERVICE_TYPE_LABELS,
  type ServiceType,
} from "@/lib/recurringServiceTypes";

type OccurrenceLike = {
  status: string;
  invoice_due_date: string | null;
  collection_due_date: string | null;
};

const COUNTRY_TIME_ZONES: Record<string, string> = {
  CL: "America/Santiago",
  UY: "America/Montevideo",
};

/**
 * Today's calendar date ("YYYY-MM-DD") where the company operates. The
 * server runs in UTC, so a plain `new Date().toISOString()` flips to
 * tomorrow from ~21:00 in Chile/Uruguay -- marking something Facturado
 * at night would stamp the wrong day, and overdue badges would turn red
 * a few hours early.
 */
export function todayForCountry(country: string | null, now: Date = new Date()): string {
  const timeZone = COUNTRY_TIME_ZONES[country ?? ""] ?? "America/Montevideo";
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** The due date that matters for the next action: invoicing, or collecting once invoiced. */
export function relevantDueDate(occurrence: OccurrenceLike): string | null {
  if (occurrence.status === "invoiced") {
    return occurrence.collection_due_date ?? occurrence.invoice_due_date;
  }
  return occurrence.invoice_due_date;
}

export function isOverdue(occurrence: OccurrenceLike, today: string): boolean {
  const due = relevantDueDate(occurrence);
  return due !== null && due < today;
}

/** Soonest (most overdue) first; undated ones last so they don't jump the queue. */
export function compareByDueDate(a: OccurrenceLike, b: OccurrenceLike): number {
  const dueA = relevantDueDate(a);
  const dueB = relevantDueDate(b);
  if (dueA === dueB) return 0;
  if (dueA === null) return 1;
  if (dueB === null) return -1;
  return dueA < dueB ? -1 : 1;
}

/**
 * Groups by service type -- the Trello board's columns -- in the fixed
 * SERVICE_TYPES order (untyped services last), each group sorted with
 * `compare`. Empty groups are omitted.
 */
export function groupByServiceType<T extends { service_type: string | null }>(
  items: T[],
  compare: (a: T, b: T) => number,
): { type: ServiceType | null; label: string; rows: T[] }[] {
  const groups = new Map<ServiceType | null, T[]>();
  for (const item of items) {
    const key = SERVICE_TYPES.includes(item.service_type as ServiceType)
      ? (item.service_type as ServiceType)
      : null;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }

  return [...SERVICE_TYPES, null]
    .filter((type) => groups.has(type))
    .map((type) => ({
      type,
      label: type ? SERVICE_TYPE_LABELS[type] : "Sin tipo especificado",
      rows: [...groups.get(type)!].sort(compare),
    }));
}

const MONTH_LABELS = [
  "ene", "feb", "mar", "abr", "may", "jun",
  "jul", "ago", "sep", "oct", "nov", "dic",
];

/**
 * "sep 2026" for a monthly period, "2026" for an annual one. Parsed from
 * the raw "YYYY-MM-DD" string, not `new Date(period)`, so a timezone
 * shift can't land it on the wrong month.
 */
export function formatPeriod(period: string, periodicity: "monthly" | "annual"): string {
  const [year, month] = period.split("-");
  if (periodicity === "annual") return year;
  return `${MONTH_LABELS[Number(month) - 1]} ${year}`;
}

export function formatDueDate(value: string | null): string {
  if (!value) return "sin fecha";
  const [year, month, day] = value.split("-");
  return `${day}/${month}/${year}`;
}

/** The one-tap label for an open occurrence, as on the old Trello cards. */
export function nextActionLabel(status: string): "Facturar" | "Cobrar" | null {
  if (status === "pending_invoice") return "Facturar";
  if (status === "invoiced") return "Cobrar";
  return null;
}
