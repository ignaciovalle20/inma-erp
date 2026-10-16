import Link from "next/link";
import { redirect } from "next/navigation";
import {
  getSession,
  getCompanyForEdit,
  getPendingRecurringServiceOccurrences,
  getRecurringServices,
  type RecurringServiceWithClient,
} from "@/lib/dal";
import {
  amountTolerance,
  ensureRecurringServicePeriods,
  getPeriodSummaries,
  type PeriodSummary,
} from "@/lib/salesAllocations";
import { PageHeader } from "@/components/PageHeader";
import { LinkButton } from "@/components/Button";
import { Badge } from "@/components/Badge";
import { Money } from "@/components/Money";
import { TableCard, Th, Td } from "@/components/Table";
import { EmptyState } from "@/components/EmptyState";
import { isValidMonth, monthLabel } from "@/lib/period";
import {
  FIRST_PERIOD_MONTH,
  RENEWAL_WARNING_DAYS,
  SERVICE_TYPE_LABELS,
  daysBetween,
  nextRenewalDate,
  type ServiceType,
} from "@/lib/recurringServiceTypes";
import { boardMonthOf, clampMonth, shiftMonth, todayForCountry } from "@/lib/recurringServicePending";
import { formatDisplayDate } from "@/lib/paymentStatus";
import { RecurringServicesNav } from "../nav";

const WINDOW_MONTHS = 6;

const MONTH_SHORT = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

function shortMonth(month: string): string {
  const [year, m] = month.split("-").map(Number);
  return `${MONTH_SHORT[m - 1]} ${String(year).slice(2)}`;
}

function PeriodCell({ companyId, period }: { companyId: string; period: PeriodSummary }) {
  const tolerance = amountTolerance(period.currency);
  const billed = period.confirmed_count > 0;
  const showDifference = billed && Math.abs(period.difference) > tolerance;

  let body: React.ReactNode;
  if (period.billing_status === "void") {
    body = <span className="text-[11.5px] text-[var(--color-faint)]">Anulado</span>;
  } else if (period.billing_status === "pending_invoice") {
    body = (
      <>
        <span title="Estimado (monto esperado)" className="text-[var(--color-faint)]">
          <Money value={period.expected_amount} currency={period.currency} showCurrency={false} />
        </span>
        <span className="text-[10.5px] text-[var(--color-faint)]">
          {period.suggested_count > 0 ? "sugerida" : "por facturar"}
        </span>
      </>
    );
  } else {
    const paid = period.billing_status === "paid";
    body = (
      <>
        <Money
          value={billed ? period.billed_amount : period.expected_amount}
          currency={period.currency}
          showCurrency={false}
          className="text-[var(--color-ink)]"
        />
        <span
          className={`text-[10.5px] font-medium ${
            paid ? "text-[var(--color-accent-strong)]" : "text-[var(--color-warning-ink)]"
          }`}
        >
          {paid ? "pagado" : "se debe"}
        </span>
      </>
    );
  }

  return (
    <Link
      href={`/companies/${companyId}/recurring-services/periods/${period.id}`}
      className="flex flex-col items-end gap-0.5 rounded-md px-1 py-0.5 text-[12.5px] no-underline hover:bg-[var(--color-row)]"
    >
      {body}
      {showDifference ? (
        <span
          title="Diferencia entre lo facturado y lo esperado"
          className={`font-mono text-[10.5px] ${
            period.difference > 0 ? "text-[var(--color-accent-strong)]" : "text-[var(--color-negative-ink)]"
          }`}
        >
          {period.difference > 0 ? "+" : ""}
          <Money
            value={period.difference}
            currency={period.currency}
            showCurrency={false}
            negativeClassName=""
          />
        </span>
      ) : null}
      {period.quantity !== null ? (
        <span className="text-[10.5px] text-[var(--color-muted)]">{period.quantity} u.</span>
      ) : null}
    </Link>
  );
}

/**
 * Períodos: one row per service (grouped by client), one column per due
 * month from September 2026 -- expected amount in grey while nothing is
 * billed (an estimate), what was billed once invoices are allocated, the
 * state (pendiente / se debe / pagado) and the difference against the
 * expected amount. Opening the page creates the missing periods through
 * next month. Domains renewing soon are highlighted.
 */
export default async function RecurringServicePeriodsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ period?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const user = await getSession();

  if (!user) {
    redirect("/login");
  }

  const membership = await getCompanyForEdit(id);

  if (!membership) {
    redirect("/companies");
  }

  const today = todayForCountry(membership.company.country);
  const lastMonth = shiftMonth(clampMonth(today.slice(0, 7), FIRST_PERIOD_MONTH, "9999-12"), 1);
  const defaultStart = clampMonth(shiftMonth(lastMonth, -(WINDOW_MONTHS - 1)), FIRST_PERIOD_MONTH, lastMonth);
  const start = clampMonth(isValidMonth(sp.period) ? sp.period : defaultStart, FIRST_PERIOD_MONTH, lastMonth);
  const months = Array.from({ length: WINDOW_MONTHS }, (_, i) => shiftMonth(start, i)).filter(
    (month) => month <= lastMonth,
  );
  const basePath = `/companies/${id}/recurring-services/periods`;

  const generationFailed = (await ensureRecurringServicePeriods(id, lastMonth)) === null;
  const [services, summaries, pending] = await Promise.all([
    getRecurringServices(id),
    getPeriodSummaries(id, { fromMonth: start }),
    getPendingRecurringServiceOccurrences(id),
  ]);

  const serviceById = new Map(services.map((service) => [service.id, service]));
  const cell = new Map<string, PeriodSummary>();
  const servicesWithPeriods = new Set<string>();
  for (const period of summaries) {
    const service = serviceById.get(period.recurring_service_id);
    if (!service) continue;
    const month = boardMonthOf({
      invoice_due_date: period.invoice_due_date,
      period: period.period,
      service_periodicity: service.periodicity,
      service_invoicing_mode: service.invoicing_mode,
      service_due_month: service.due_month,
    });
    if (!months.includes(month)) continue;
    cell.set(`${service.id}:${month}`, period);
    servicesWithPeriods.add(service.id);
  }

  const rows = services
    .filter((service) => service.status === "active" || servicesWithPeriods.has(service.id))
    .sort(
      (a, b) =>
        (a.client_name ?? "").localeCompare(b.client_name ?? "", "es") || a.name.localeCompare(b.name, "es"),
    );

  // Totals per month and currency: expected (every live period) and billed.
  const totals = new Map<string, Map<string, { expected: number; billed: number }>>();
  for (const [key, period] of cell) {
    if (period.billing_status === "void") continue;
    const month = key.split(":")[1];
    const byCurrency = totals.get(period.currency) ?? new Map();
    const entry = byCurrency.get(month) ?? { expected: 0, billed: 0 };
    entry.expected += period.expected_amount;
    entry.billed += period.billed_amount;
    byCurrency.set(month, entry);
    totals.set(period.currency, byCurrency);
  }

  const renewals = services
    .filter((service) => service.service_type === "domain" && service.status === "active")
    .map((service) => {
      const date = nextRenewalDate(service, today);
      return date ? { service, date, days: daysBetween(today, date) } : null;
    })
    .filter((row): row is { service: RecurringServiceWithClient; date: string; days: number } =>
      Boolean(row && row.days <= RENEWAL_WARNING_DAYS),
    )
    .sort((a, b) => a.date.localeCompare(b.date));
  const renewalByService = new Map(renewals.map((row) => [row.service.id, row]));

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <PageHeader
        eyebrow="GESTIÓN / SERVICIOS RECURRENTES / PERÍODOS"
        title="Servicios recurrentes"
        subtitle={membership.company.name}
        actions={
          <LinkButton href={`/companies/${id}/recurring-services/services/new`} variant="primary">
            Nuevo servicio
          </LinkButton>
        }
      />

      <RecurringServicesNav companyId={id} active="periods" debtCount={pending.length} />

      <div className="flex flex-wrap items-center gap-3 text-[12.5px]">
        {start > FIRST_PERIOD_MONTH ? (
          <Link href={`${basePath}?period=${shiftMonth(start, -1)}`} className="text-[var(--color-accent-strong)]">
            ◂ Mes anterior
          </Link>
        ) : null}
        <span className="font-medium text-[var(--color-ink)]">
          {monthLabel(months[0])} – {monthLabel(months[months.length - 1])}
        </span>
        {months[months.length - 1] < lastMonth ? (
          <Link href={`${basePath}?period=${shiftMonth(start, 1)}`} className="text-[var(--color-accent-strong)]">
            Mes siguiente ▸
          </Link>
        ) : null}
        <span className="text-[var(--color-muted)]">
          Gris = esperado (estimado) · negro = facturado · la diferencia es facturado − esperado.
        </span>
      </div>

      {generationFailed ? (
        <p role="alert" className="text-[12.5px] text-[var(--color-negative-ink)]">
          No se pudieron generar los períodos que faltaban. Probá recargar la página.
        </p>
      ) : null}

      {renewals.length > 0 ? (
        <section
          aria-label="Dominios por renovar"
          className="flex flex-col gap-1.5 rounded-[10px] border border-[var(--color-warning-soft-border)] bg-[var(--color-warning-panel)] p-3 text-[12.5px] text-[var(--color-warning-ink)]"
        >
          <p className="font-semibold">
            {renewals.length === 1 ? "1 dominio renueva" : `${renewals.length} dominios renuevan`} en los próximos{" "}
            {RENEWAL_WARNING_DAYS} días
          </p>
          <ul className="flex flex-col gap-0.5">
            {renewals.map(({ service, date, days }) => (
              <li key={service.id}>
                <Link
                  href={`/companies/${id}/recurring-services/services/${service.id}`}
                  className="font-medium text-inherit"
                >
                  {service.name}
                </Link>{" "}
                · {service.client_name ?? "Cliente desconocido"} · {formatDisplayDate(date)} (
                {days === 0 ? "hoy" : days === 1 ? "mañana" : `en ${days} días`})
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {rows.length === 0 ? (
        <div className="rounded-[10px] border border-[var(--color-hairline)] bg-[var(--color-surface)]">
          <EmptyState message="Todavía no hay servicios recurrentes activos." />
        </div>
      ) : (
        <TableCard>
          <thead>
            <tr>
              <Th>Cliente / servicio</Th>
              {months.map((month) => (
                <Th key={month} align="right">
                  {shortMonth(month)}
                </Th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((service, index) => {
              const showClient = index === 0 || rows[index - 1].client_name !== service.client_name;
              const renewal = renewalByService.get(service.id);
              const renewalDate = service.service_type === "domain" ? nextRenewalDate(service, today) : null;
              return (
                <tr key={service.id} className="hover:bg-[var(--color-surface-muted)]">
                  <Td className="min-w-[220px]">
                    {showClient ? (
                      <span className="block font-medium text-[var(--color-ink)]">
                        {service.client_name ?? "Cliente desconocido"}
                      </span>
                    ) : null}
                    <span className="flex flex-wrap items-center gap-1.5">
                      <Link
                        href={`/companies/${id}/recurring-services/services/${service.id}`}
                        className="text-[12.5px] text-[var(--color-ink-2)] hover:underline"
                      >
                        {service.name}
                      </Link>
                      {service.service_type ? (
                        <Badge variant={service.service_type === "domain" ? "warning" : "outline"}>
                          {SERVICE_TYPE_LABELS[service.service_type as ServiceType] ?? service.service_type}
                        </Badge>
                      ) : null}
                      {service.status !== "active" ? <Badge variant="neutral">Inactivo</Badge> : null}
                    </span>
                    {renewalDate ? (
                      <span
                        className={`block text-[11px] ${
                          renewal ? "font-medium text-[var(--color-warning-ink)]" : "text-[var(--color-faint)]"
                        }`}
                      >
                        Renueva {formatDisplayDate(renewalDate)}
                      </span>
                    ) : null}
                    {service.pricing_mode === "per_unit" && service.unit_price !== null ? (
                      <span className="block text-[11px] text-[var(--color-faint)]">
                        <Money value={service.unit_price} currency={service.currency} showCurrency={false} /> por unidad
                      </span>
                    ) : null}
                  </Td>
                  {months.map((month) => {
                    const period = cell.get(`${service.id}:${month}`);
                    return (
                      <Td key={month} align="right" className="whitespace-nowrap">
                        {period ? (
                          <PeriodCell companyId={id} period={period} />
                        ) : (
                          <span className="text-[var(--color-faint)]">·</span>
                        )}
                      </Td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
          {totals.size > 0 ? (
            <tfoot>
              {[...totals.entries()].map(([currency, byMonth]) => (
                <tr key={currency} className="bg-[var(--color-surface-muted)]">
                  <td className="px-3 py-2.5 text-[12px] font-medium text-[var(--color-muted)]">
                    Total {currency} · esperado / facturado
                  </td>
                  {months.map((month) => {
                    const entry = byMonth.get(month);
                    return (
                      <td key={month} className="px-3 py-2.5 text-right text-[12px]">
                        {entry ? (
                          <span className="flex flex-col items-end">
                            <Money
                              value={entry.expected}
                              currency={currency}
                              showCurrency={false}
                              className="text-[var(--color-faint)]"
                            />
                            <Money value={entry.billed} currency={currency} showCurrency={false} className="font-semibold" />
                          </span>
                        ) : null}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tfoot>
          ) : null}
        </TableCard>
      )}
    </div>
  );
}
