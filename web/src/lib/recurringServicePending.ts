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

/**
 * Statuses still waiting on the user: to invoice, or to collect
 * ('invoiced' already means "pending collection"; 'pending_collection'
 * is where a cycle of a service that doesn't require an invoice starts).
 */
export const OPEN_OCCURRENCE_STATUSES = ["pending_invoice", "invoiced", "pending_collection"] as const;

export function isOpenStatus(status: string): boolean {
  return (OPEN_OCCURRENCE_STATUSES as readonly string[]).includes(status);
}

/** The due date that matters for the next action: invoicing, or collecting once invoiced. */
export function relevantDueDate(occurrence: OccurrenceLike): string | null {
  if (occurrence.status === "invoiced" || occurrence.status === "pending_collection") {
    return occurrence.collection_due_date ?? occurrence.invoice_due_date;
  }
  return occurrence.invoice_due_date;
}

/** Past its due date and still not collected (or voided). */
export function isOverdue(occurrence: OccurrenceLike, today: string): boolean {
  if (!isOpenStatus(occurrence.status)) return false;
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
  if (status === "invoiced" || status === "pending_collection") return "Cobrar";
  return null;
}

/** The card badge: Facturar / Cobrar / Pagado (or Anulado). */
export function boardBadge(status: string): {
  label: "Facturar" | "Cobrar" | "Pagado" | "Anulado";
  variant: "neutral" | "warning" | "positive" | "outline";
} {
  if (status === "collected") return { label: "Pagado", variant: "positive" };
  if (status === "void") return { label: "Anulado", variant: "outline" };
  if (status === "pending_invoice") return { label: "Facturar", variant: "neutral" };
  return { label: "Cobrar", variant: "warning" };
}

// ---------------------------------------------------------------------
// Month board (the Planner replacement)
// ---------------------------------------------------------------------

/** "YYYY-MM" shifted by `delta` months. */
export function shiftMonth(month: string, delta: number): string {
  const [year, m] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year, m - 1 + delta, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * The month a cycle belongs to on the board: the month it is due in
 * (what you act on that month). That's its due date's month; cycles
 * loaded before due dates were always filled fall back to the same rule
 * the generator uses (anticipado: the period itself; vencido: the month
 * after; annual: its due month).
 */
export function boardMonthOf(occurrence: {
  invoice_due_date: string | null;
  period: string;
  service_periodicity: string;
  service_invoicing_mode: string;
  service_due_month: number | null;
}): string {
  if (occurrence.invoice_due_date) return occurrence.invoice_due_date.slice(0, 7);
  const periodMonth = occurrence.period.slice(0, 7);
  if (occurrence.service_periodicity === "annual") {
    const year =
      Number(periodMonth.slice(0, 4)) + (occurrence.service_invoicing_mode === "arrears" ? 1 : 0);
    return `${year}-${String(occurrence.service_due_month ?? 1).padStart(2, "0")}`;
  }
  return occurrence.service_invoicing_mode === "arrears" ? shiftMonth(periodMonth, 1) : periodMonth;
}

/** Keeps a requested board month within [min, max]. */
export function clampMonth(month: string, min: string, max: string): string {
  if (month < min) return min;
  if (month > max) return max;
  return month;
}

/** The board's columns, as in Planner: Hosting, Licencias MS, Starlink/Servidor. */
export const BOARD_GROUPS: { key: string; label: string; types: (string | null)[] }[] = [
  { key: "hosting", label: "Hosting", types: ["hosting"] },
  { key: "ms_licenses", label: "Licencias MS", types: ["ms_licenses"] },
  { key: "starlink_server", label: "Starlink / Servidor", types: ["starlink", "server"] },
  { key: "other", label: "Otros", types: ["other", null] },
];

export function groupForBoard<T extends { service_type: string | null }>(
  items: T[],
  compare: (a: T, b: T) => number,
): { key: string; label: string; rows: T[] }[] {
  return BOARD_GROUPS.map((group) => ({
    key: group.key,
    label: group.label,
    rows: items
      .filter((item) => {
        const type = SERVICE_TYPES.includes(item.service_type as ServiceType) ? item.service_type : null;
        return group.types.includes(type);
      })
      .sort(compare),
  })).filter((group) => group.rows.length > 0);
}

export type CurrencyTotals = {
  currency: string;
  toInvoice: number;
  toCollect: number;
  collected: number;
  /** Part of toInvoice + toCollect already past due; only when `today` is given. */
  overdue?: number;
};

const CURRENCY_ORDER = ["CLP", "USD", "UYU"];

/**
 * Month summary, one row per currency -- CLP, USD and UYU are never
 * added together. Voided cycles count nowhere. With `today`, each row
 * also says how much of what's still open is overdue.
 */
export function totalsByCurrency(
  occurrences: {
    status: string;
    amount: number;
    currency: string;
    invoice_due_date?: string | null;
    collection_due_date?: string | null;
  }[],
  today?: string,
): CurrencyTotals[] {
  const byCurrency = new Map<string, CurrencyTotals>();
  for (const o of occurrences) {
    if (o.status === "void") continue;
    const totals =
      byCurrency.get(o.currency) ?? {
        currency: o.currency,
        toInvoice: 0,
        toCollect: 0,
        collected: 0,
        ...(today ? { overdue: 0 } : {}),
      };
    const amount = Number(o.amount);
    if (o.status === "pending_invoice") totals.toInvoice += amount;
    else if (o.status === "collected") totals.collected += amount;
    else totals.toCollect += amount;
    if (
      today &&
      isOverdue(
        {
          status: o.status,
          invoice_due_date: o.invoice_due_date ?? null,
          collection_due_date: o.collection_due_date ?? null,
        },
        today,
      )
    ) {
      totals.overdue = (totals.overdue ?? 0) + amount;
    }
    byCurrency.set(o.currency, totals);
  }
  return [...byCurrency.values()].sort(
    (a, b) => CURRENCY_ORDER.indexOf(a.currency) - CURRENCY_ORDER.indexOf(b.currency),
  );
}

/** Whole days from `due` to `today` (negative when not yet due). */
export function daysPastDue(due: string, today: string): number {
  const ms = Date.parse(`${today}T00:00:00Z`) - Date.parse(`${due}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

/** "vence en 3 días" / "vence hoy" / "vencido hace 12 días" / "sin vencimiento". */
export function describeAge(due: string | null, today: string): string {
  if (!due) return "sin vencimiento";
  const days = daysPastDue(due, today);
  if (days === 0) return "vence hoy";
  if (days < 0) return `vence en ${-days} ${days === -1 ? "día" : "días"}`;
  return `vencido hace ${days} ${days === 1 ? "día" : "días"}`;
}

/**
 * Deuda's two blocks: "Vencido" (due before today and not collected) and
 * "Por vencer" (every other open cycle, undated ones included). Collected
 * and voided cycles are in neither.
 */
export function splitByOverdue<T extends OccurrenceLike>(
  occurrences: T[],
  today: string,
): { overdue: T[]; upcoming: T[] } {
  const overdue: T[] = [];
  const upcoming: T[] = [];
  for (const o of occurrences) {
    if (!isOpenStatus(o.status)) continue;
    (isOverdue(o, today) ? overdue : upcoming).push(o);
  }
  return { overdue, upcoming };
}

/**
 * Deuda: every open cycle grouped by client, oldest due date first
 * within a client, the client with the oldest debt first. Subtotals per
 * currency, never mixed.
 */
export function debtByClient<
  T extends OccurrenceLike & {
    client_id: string | null;
    client_name: string | null;
    amount: number;
    currency: string;
  },
>(
  occurrences: T[],
): {
  clientId: string | null;
  clientName: string;
  rows: T[];
  totals: { currency: string; amount: number }[];
}[] {
  const groups = new Map<string, { clientId: string | null; clientName: string; rows: T[] }>();
  for (const o of occurrences) {
    if (!isOpenStatus(o.status)) continue;
    const key = o.client_id ?? "none";
    const group = groups.get(key) ?? {
      clientId: o.client_id,
      clientName: o.client_name ?? "Cliente desconocido",
      rows: [],
    };
    group.rows.push(o);
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((group) => {
      const rows = [...group.rows].sort(compareByDueDate);
      const totals = new Map<string, number>();
      for (const row of rows) totals.set(row.currency, (totals.get(row.currency) ?? 0) + Number(row.amount));
      return {
        ...group,
        rows,
        totals: [...totals.entries()]
          .map(([currency, amount]) => ({ currency, amount }))
          .sort((a, b) => CURRENCY_ORDER.indexOf(a.currency) - CURRENCY_ORDER.indexOf(b.currency)),
      };
    })
    .sort(
      (a, b) =>
        compareByDueDate(a.rows[0], b.rows[0]) || a.clientName.localeCompare(b.clientName, "es"),
    );
}

/** Last day ("YYYY-MM-DD") of a cycle's period: the month, or the whole year for an annual service. */
export function periodEnd(period: string, periodicity: string): string {
  const [year, month] = period.split("-").map(Number);
  const end =
    periodicity === "annual" ? new Date(Date.UTC(year + 1, 0, 0)) : new Date(Date.UTC(year, month, 0));
  return end.toISOString().slice(0, 10);
}

/**
 * Cycles left before a service's (new) start date -- their whole period
 * ends before it. Kept, never deleted; `open` are the ones that can still
 * be voided.
 */
export function cyclesBeforeStart<T extends { period: string; status: string }>(
  cycles: T[],
  startDate: string,
  periodicity: string,
): { all: T[]; open: T[] } {
  const all = cycles.filter((c) => c.status !== "void" && periodEnd(c.period, periodicity) < startDate);
  return { all, open: all.filter((c) => isOpenStatus(c.status)) };
}

/**
 * For "Marcar como facturado / cobrado hasta [mes]": how many cycles each
 * action would change if run up to `month` ("YYYY-MM", inclusive, by the
 * month each cycle is due) -- mirrors bulk_mark_recurring_service_occurrences.
 */
export function bulkMarkCounts(
  cycles: { status: string; invoice_due_date: string | null; period: string }[],
  month: string,
): { invoice: number; collect: number } {
  const due = cycles.filter((c) => (c.invoice_due_date ?? c.period).slice(0, 7) <= month);
  return {
    invoice: due.filter((c) => c.status === "pending_invoice").length,
    collect: due.filter((c) => isOpenStatus(c.status)).length,
  };
}

/** A cycle flagged "revisar vínculo" by the invoice matching and still unlinked. */
export function needsLinkReview(cycle: { link_review: string | null; sales_document_id: string | null }): boolean {
  return (cycle.link_review === "no_match" || cycle.link_review === "multiple") && !cycle.sales_document_id;
}
