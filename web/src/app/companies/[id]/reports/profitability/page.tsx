import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession, getCompanyForEdit } from "@/lib/dal";
import { getProfitabilityBreakdown, monthRange } from "@/lib/reporting";
import { PageHeader } from "@/components/PageHeader";
import { PeriodPicker } from "@/components/PeriodPicker";
import { ProfitabilityTabs } from "@/components/ProfitabilityTabs";

function currentMonth(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

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

  const period = /^\d{4}-\d{2}$/.test(periodParam ?? "")
    ? (periodParam as string)
    : currentMonth();
  const periodDate = `${period}-01`;

  const breakdown = await getProfitabilityBreakdown(id, periodDate);
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
    <div className="flex flex-col gap-[18px]">
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
