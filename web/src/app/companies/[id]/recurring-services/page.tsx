import Link from "next/link";
import { redirect } from "next/navigation";
import {
  getSession,
  getCompanyForEdit,
  ensureRecurringServiceOccurrencesForMonth,
  getPendingRecurringServiceOccurrences,
  getRecurringServiceOccurrencesForMonth,
  type RecurringServiceOccurrenceRow,
} from "@/lib/dal";
import { PageHeader } from "@/components/PageHeader";
import { LinkButton } from "@/components/Button";
import { PeriodPicker } from "@/components/PeriodPicker";
import { Money } from "@/components/Money";
import { EmptyState } from "@/components/EmptyState";
import { isValidMonth, monthLabel } from "@/lib/period";
import { FIRST_BOARD_MONTH, serviceCountry } from "@/lib/recurringServiceTypes";
import {
  clampMonth,
  compareByDueDate,
  groupForBoard,
  isOpenStatus,
  shiftMonth,
  todayForCountry,
  totalsByCurrency,
} from "@/lib/recurringServicePending";
import { RecurringServicesNav } from "./nav";
import { OccurrenceCard } from "./occurrence-card";

/** Open cycles first, then by due date, then client. */
function compareCards(a: RecurringServiceOccurrenceRow, b: RecurringServiceOccurrenceRow): number {
  const openA = isOpenStatus(a.status) ? 0 : 1;
  const openB = isOpenStatus(b.status) ? 0 : 1;
  return (
    openA - openB ||
    compareByDueDate(a, b) ||
    (a.client_name ?? "").localeCompare(b.client_name ?? "", "es")
  );
}

/**
 * Mes a mes: the in-ERP replacement for the Planner board. Each month
 * shows the cycles due that month, grouped like Planner's columns, with
 * one-tap Facturado / Cobrado. Opening a month creates whatever cycles
 * are missing for it (idempotent). September 2026 is the first month;
 * the last one is next month (to prepare advance invoices).
 */
export default async function RecurringServicesMonthPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ period?: string; pendientes?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const user = await getSession();

  if (!user) {
    redirect("/login");
  }

  // Any membership (any role) is enough -- getCompanyForEdit doubles as
  // the membership check here.
  const membership = await getCompanyForEdit(id);

  if (!membership) {
    redirect("/companies");
  }

  const country = serviceCountry(membership.company.country);
  const today = todayForCountry(membership.company.country);
  const currentMonth = today.slice(0, 7);
  const maxMonth = shiftMonth(clampMonth(currentMonth, FIRST_BOARD_MONTH, "9999-12"), 1);
  const month = clampMonth(
    isValidMonth(sp.period) ? sp.period : currentMonth,
    FIRST_BOARD_MONTH,
    maxMonth,
  );
  const onlyPending = sp.pendientes === "1";
  const basePath = `/companies/${id}/recurring-services`;

  const generationFailed = (await ensureRecurringServiceOccurrencesForMonth(id, month)) === null;
  const [occurrences, pending] = await Promise.all([
    getRecurringServiceOccurrencesForMonth(id, month),
    getPendingRecurringServiceOccurrences(id),
  ]);

  const visible = onlyPending ? occurrences.filter((o) => isOpenStatus(o.status)) : occurrences;
  const groups = groupForBoard(visible, compareCards);
  const totals = totalsByCurrency(occurrences, today);
  const openCount = occurrences.filter((o) => isOpenStatus(o.status)).length;

  return (
    <div className="flex flex-col gap-[18px]">
      <PageHeader
        eyebrow="GESTIÓN / SERVICIOS RECURRENTES / TABLERO DEL MES"
        title="Servicios recurrentes"
        subtitle={membership.company.name}
        actions={
          <LinkButton href={`${basePath}/services/new`} variant="primary">
            Nuevo servicio
          </LinkButton>
        }
      />

      <RecurringServicesNav companyId={id} active="month" debtCount={pending.length} />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <PeriodPicker
          period={month}
          basePath={basePath}
          min={FIRST_BOARD_MONTH}
          max={maxMonth}
          query={onlyPending ? "&pendientes=1" : ""}
        />
        <Link
          href={`${basePath}?period=${month}${onlyPending ? "" : "&pendientes=1"}`}
          aria-pressed={onlyPending}
          className={`rounded-lg border px-3 py-[7px] text-[12.5px] font-medium no-underline ${
            onlyPending
              ? "border-[var(--color-ink)] bg-[var(--color-ink)] text-[var(--color-on-ink)]"
              : "border-[var(--color-hairline)] bg-[var(--color-surface)] text-[var(--color-ink-2)]"
          }`}
        >
          {onlyPending ? "✓ " : ""}Solo pendientes{openCount > 0 ? ` (${openCount})` : ""}
        </Link>
      </div>

      {generationFailed ? (
        <p role="alert" className="text-[12.5px] text-[var(--color-negative-ink)]">
          No se pudieron generar los ciclos de este mes. Probá recargar la página.
        </p>
      ) : null}

      <section aria-label={`Resumen de ${monthLabel(month)}`} className="flex flex-col gap-2">
        {totals.length === 0 ? null : (
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {totals.map((row) => (
              <div
                key={row.currency}
                className="flex flex-col gap-1.5 rounded-[10px] border border-[var(--color-hairline)] bg-[var(--color-surface)] p-3"
              >
                <p className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-[var(--color-muted)]">
                  {monthLabel(month)} · {row.currency}
                </p>
                <dl className="grid grid-cols-2 gap-2 text-[12px]">
                  <div>
                    <dt className="text-[var(--color-muted)]">Por facturar</dt>
                    <dd className="font-medium">
                      <Money value={row.toInvoice} currency={row.currency} showCurrency={false} />
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[var(--color-muted)]">Por cobrar</dt>
                    <dd className="font-medium text-[var(--color-warning-ink)]">
                      <Money value={row.toCollect} currency={row.currency} showCurrency={false} />
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[var(--color-muted)]" title="Parte de lo por facturar y por cobrar que ya venció">
                      Vencido
                    </dt>
                    <dd
                      className={`font-medium ${
                        row.overdue ? "text-[var(--color-negative-ink)]" : "text-[var(--color-muted)]"
                      }`}
                    >
                      <Money value={row.overdue ?? 0} currency={row.currency} showCurrency={false} />
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[var(--color-muted)]">Cobrado</dt>
                    <dd className="font-medium text-[var(--color-accent-strong)]">
                      <Money value={row.collected} currency={row.currency} showCurrency={false} />
                    </dd>
                  </div>
                </dl>
              </div>
            ))}
          </div>
        )}
      </section>

      {groups.length === 0 ? (
        <div className="rounded-[10px] border border-[var(--color-hairline)] bg-[var(--color-surface)]">
          <EmptyState
            message={
              onlyPending
                ? `No queda nada pendiente en ${monthLabel(month)}.`
                : `No hay ciclos con vencimiento en ${monthLabel(month)}.`
            }
          />
        </div>
      ) : (
        <div className="grid items-start gap-4 md:grid-cols-2 xl:grid-cols-3">
          {groups.map((group) => (
            <section key={group.key} className="flex flex-col gap-2">
              <h2 className="text-[12.5px] font-semibold uppercase tracking-[0.08em] text-[var(--color-muted)]">
                {group.label} <span className="font-normal">· {group.rows.length}</span>
              </h2>
              <ul className="flex flex-col gap-2">
                {group.rows.map((occurrence) => (
                  <OccurrenceCard
                    key={occurrence.id}
                    companyId={id}
                    occurrence={occurrence}
                    today={today}
                    country={country}
                  />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
