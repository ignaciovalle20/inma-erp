import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession, getCompanyForEdit } from "@/lib/dal";
import {
  computeMonthlyResult,
  getMonthlySeries,
  getProfitabilityBreakdown,
  monthRange,
} from "@/lib/reporting";
import { PageHeader } from "@/components/PageHeader";
import { PeriodPicker } from "@/components/PeriodPicker";
import { Card } from "@/components/Card";
import { KpiCard } from "@/components/KpiCard";
import { MonthlyChart } from "@/components/MonthlyChart";
import { Waterfall } from "@/components/Waterfall";
import { Money } from "@/components/Money";
import { TableCard, Th, Td, Tr } from "@/components/Table";
import { Badge } from "@/components/Badge";

function currentMonth(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

export default async function CompanyDashboardPage({
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

  const membership = await getCompanyForEdit(id);

  if (!membership) {
    redirect("/companies");
  }

  const period = /^\d{4}-\d{2}$/.test(periodParam ?? "")
    ? (periodParam as string)
    : currentMonth();
  const periodDate = `${period}-01`;
  const currency = membership.company.currency;

  const [result, series, breakdown] = await Promise.all([
    computeMonthlyResult(id, periodDate),
    getMonthlySeries(id, periodDate, 12),
    getProfitabilityBreakdown(id, periodDate),
  ]);

  const previous = series.length > 1 ? series[series.length - 2] : undefined;

  const { start, end } = monthRange(periodDate);
  const salesHref = `/companies/${id}/sales?from=${start}&to=${end}&voided=exclude`;
  const directCostsHref = `/companies/${id}/costs?from=${start}&to=${end}&classification=direct`;

  const topProjects = [...breakdown.projects]
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 8);

  return (
    <div className="flex flex-col gap-[18px]">
      <PageHeader
        eyebrow="GESTIÓN / RESUMEN"
        title="Panel de control"
        subtitle={membership.company.name}
        actions={<PeriodPicker period={period} basePath={`/companies/${id}`} />}
      />

      <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          label="Ventas netas"
          value={result.netSales}
          currency={currency}
          href={salesHref}
          previousValue={previous?.netSales}
          favorableWhen="up"
          proportion={1}
        />
        <KpiCard
          label="Costos directos"
          value={result.directCosts}
          currency={currency}
          href={directCostsHref}
          previousValue={previous?.directCosts}
          favorableWhen="down"
          proportion={result.netSales !== 0 ? result.directCosts / result.netSales : 0}
        />
        <KpiCard
          label="Margen directo"
          value={result.directMargin}
          currency={currency}
          previousValue={previous?.directMargin}
          favorableWhen="up"
          proportion={result.netSales !== 0 ? result.directMargin / result.netSales : 0}
        />
        <KpiCard
          label="Resultado operativo"
          value={result.operatingResult}
          currency={currency}
          previousValue={previous?.operatingResult}
          favorableWhen="up"
          proportion={result.netSales !== 0 ? Math.abs(result.operatingResult) / result.netSales : 0}
        />
      </div>

      <div className="grid grid-cols-1 gap-3.5 lg:grid-cols-[1.6fr_1fr]">
        <Card padding="20px 22px 18px" className="flex flex-col gap-3">
          <div className="flex flex-col gap-0.5">
            <h2 className="text-[14px] font-semibold text-[var(--color-ink)]">
              Ventas, costos y margen
            </h2>
            <p className="text-[11.5px] text-[var(--color-muted)]">
              Últimos 12 meses · {currency}
            </p>
          </div>
          <MonthlyChart series={series} />
          <div className="flex items-center gap-4 text-[11px] text-[var(--color-muted)]">
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-sm bg-[var(--color-accent)]" />
              Ventas
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-sm bg-[var(--color-neutral-bar)]" />
              Costos
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-[2px] w-3 bg-[var(--color-ink)]" />
              Margen %
            </span>
          </div>
        </Card>

        <Card padding="20px 22px 18px">
          <h2 className="mb-3 text-[14px] font-semibold text-[var(--color-ink)]">
            De ventas a resultado
          </h2>
          <Waterfall
            currency={currency}
            netSales={result.netSales}
            directCosts={result.directCosts}
            directMargin={result.directMargin}
            generalCosts={result.generalCosts}
            operatingResult={result.operatingResult}
          />
        </Card>
      </div>

      {result.pendingProjectCount > 0 ? (
        <div className="flex items-center gap-3 rounded-[10px] border border-[var(--color-warning-soft-border)] bg-[var(--color-warning-panel)] px-4 py-3">
          <span className="h-2 w-2 flex-none rounded-full bg-[#b08900]" />
          <div className="flex flex-col gap-0.5">
            <span className="text-[13px] font-semibold text-[var(--color-warning-ink-2)]">
              Proyectos sin costo registrado
            </span>
            <span className="text-[12.5px] text-[var(--color-warning-ink)]">
              {result.pendingProjectCount} proyecto
              {result.pendingProjectCount === 1 ? "" : "s"} sin costo
              registrado este mes -- el resultado confirmado puede bajar.
            </span>
          </div>
          <Link
            href={`/companies/${id}/projects`}
            className="ml-auto whitespace-nowrap text-[13px] font-medium text-[var(--color-warning-ink-2)]"
          >
            Revisar proyectos →
          </Link>
        </div>
      ) : null}

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h2 className="text-[14px] font-semibold text-[var(--color-ink)]">
            Proyectos del mes
          </h2>
          <Link
            href={`/companies/${id}/reports/profitability`}
            className="text-[13px] font-medium text-[var(--color-accent-strong)]"
          >
            Ver rentabilidad completa →
          </Link>
        </div>
        {topProjects.length === 0 ? (
          <p className="text-[13px] text-[var(--color-muted)]">
            No hay proyectos con ventas este mes.
          </p>
        ) : (
          <TableCard>
            <thead>
              <tr>
                <Th>Proyecto</Th>
                <Th>Cliente</Th>
                <Th align="right">Ingresos</Th>
                <Th align="right">Costos</Th>
                <Th align="right">Margen</Th>
                <Th align="right">Margen %</Th>
                <Th align="right">Vs. presupuesto</Th>
              </tr>
            </thead>
            <tbody>
              {topProjects.map((project) => {
                const marginPct =
                  project.revenue !== 0
                    ? (project.margin / project.revenue) * 100
                    : 0;
                return (
                  <Tr key={project.id}>
                    <Td className="font-medium text-[var(--color-ink)]">
                      {project.name}
                    </Td>
                    <Td className="text-[var(--color-ink-2)]">
                      {project.clientName ?? "—"}
                    </Td>
                    <Td align="right">
                      <Money value={project.revenue} currency={currency} showCurrency={false} />
                    </Td>
                    <Td align="right">
                      <Money value={project.costs} currency={currency} showCurrency={false} />
                    </Td>
                    <Td align="right" className="font-medium">
                      <Money value={project.margin} currency={currency} showCurrency={false} />
                    </Td>
                    <Td align="right">
                      <div className="flex items-center justify-end gap-2">
                        <div className="h-[5px] w-16 rounded-full bg-[var(--color-hairline-soft)]">
                          <div
                            className="h-[5px] rounded-full bg-[var(--color-accent-bright)]"
                            style={{
                              width: `${Math.max(0, Math.min(100, marginPct))}%`,
                            }}
                          />
                        </div>
                        <span className="font-mono text-[12.5px] tabular-nums">
                          {marginPct.toFixed(0)}%
                        </span>
                      </div>
                    </Td>
                    <Td align="right">
                      {project.budget === null || project.budgetVariance === null ? (
                        <Badge variant="neutral">Sin presupuesto</Badge>
                      ) : project.budgetVariance > 0 ? (
                        <Badge variant="negative">Sobre presupuesto</Badge>
                      ) : (
                        <Badge variant="positive">Bajo presupuesto</Badge>
                      )}
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
          </TableCard>
        )}
      </div>
    </div>
  );
}
