import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession, getCompanyForEdit } from "@/lib/dal";
import { computeMonthlyResult, getProfitabilityBreakdown, monthRange } from "@/lib/reporting";
import { MoneyBreakdown } from "@/components/MoneyBreakdown";
import { PageHeader } from "@/components/PageHeader";
import { PeriodPicker } from "@/components/PeriodPicker";
import { ProfitabilityTabs } from "@/components/ProfitabilityTabs";
import { DataIncompleteBanner } from "@/components/DataIncompleteBanner";
import { MONTH_PATTERN, currentMonth } from "@/lib/period";

export default async function ProfitabilityReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ period?: string }>;
}) {
  const { id } = await params;
  const { period: periodParam } = await searchParams;
  const user = await getSession();

  if (!user) {
    redirect("/login");
  }

  // Any membership (any role) is enough to view a company's reports --
  // same pattern as the Monthly Result report.
  const membership = await getCompanyForEdit(id);

  if (!membership) {
    redirect("/companies");
  }

  const period = MONTH_PATTERN.test(periodParam ?? "")
    ? (periodParam as string)
    : currentMonth(membership.company.country);
  const periodDate = `${period}-01`;

  const [breakdown, month] = await Promise.all([
    getProfitabilityBreakdown(id, periodDate),
    computeMonthlyResult(id, periodDate),
  ]);
  const currency = membership.company.currency;

  // Story 6.4: same [start, end) range each compute* function summed
  // over -- see reporting.ts's monthRange -- so drill-down links'
  // filtered sums reconcile with the figures shown here.
  const { start, end } = monthRange(periodDate);
  const salesHref = (extra: string) =>
    `/companies/${id}/sales?from=${start}&to=${end}&voided=exclude&${extra}`;
  const costsHref = (extra: string) =>
    `/companies/${id}/costs?from=${start}&to=${end}&${extra}`;

  const clients = breakdown.clients.map((row) => ({
    ...row,
    revenueHref: salesHref(`clientId=${row.id}`),
    costsHref: costsHref(`clientId=${row.id}&classification=direct`),
  }));
  const areas = breakdown.areas.map((row) => ({
    ...row,
    revenueHref: salesHref(`businessAreaId=${row.id}`),
    costsHref: costsHref(`businessAreaId=${row.id}&classification=direct`),
  }));
  const projects = breakdown.projects.map((row) => ({
    ...row,
    revenueHref: salesHref(`projectId=${row.id}`),
    costsHref: costsHref(`projectId=${row.id}&classification=direct`),
  }));

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <PageHeader
        eyebrow="ANÁLISIS / RENTABILIDAD"
        title="Rentabilidad por cliente, proyecto y área"
        subtitle={membership.company.name}
        actions={
          <PeriodPicker
            period={period}
            basePath={`/companies/${id}/reports/profitability`}
          />
        }
      />

      {breakdown.hasError ? <DataIncompleteBanner details={breakdown.errors ?? []} /> : null}

      {/* The month's totals per currency and combined (local + USD); the
          tables below are each document converted to the company's
          currency with the rate of its own date. */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {[
          { label: "Ventas netas del mes", summary: month.summaries.netSales },
          { label: "Costos directos del mes", summary: month.summaries.directCosts },
          { label: "Margen directo del mes", summary: month.summaries.directMargin },
        ].map((card) => (
          <div
            key={card.label}
            className="flex flex-col gap-1.5 rounded-[10px] border border-[var(--color-hairline)] bg-[var(--color-surface)] p-3"
          >
            <span className="caps-label text-[var(--color-muted)]">{card.label}</span>
            <MoneyBreakdown summary={card.summary} label="Total" showSubtotals />
          </div>
        ))}
      </div>
      <p className="text-[12px] text-[var(--color-muted)]">
        Montos netos (sin IVA). Las tablas están en {currency}: cada documento se convierte con el tipo de cambio de su fecha.
        {breakdown.currencyConversionPending ? " Falta el tipo de cambio de alguna fecha: hay montos sin convertir que no se suman." : ""}
      </p>

      <ProfitabilityTabs
        currency={currency}
        projects={projects}
        clients={clients}
        areas={areas}
      />

      <Link
        href={`/companies/${id}/reports/monthly-result`}
        className="text-[13px] font-medium text-[var(--color-accent-strong)]"
      >
        Ver resultado mensual
      </Link>
    </div>
  );
}
