import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession, getCompanyForEdit } from "@/lib/dal";
import {
  getMonthlySeries,
  getProfitabilityBreakdown,
  monthRange,
} from "@/lib/reporting";
import { PageHeader } from "@/components/PageHeader";
import { PeriodPicker } from "@/components/PeriodPicker";
import { Card } from "@/components/Card";
import { Money } from "@/components/Money";
import { DataIncompleteBanner } from "@/components/DataIncompleteBanner";
import { MONTH_PATTERN } from "@/lib/period";

function currentMonth(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

function IncomeRow({
  label,
  value,
  currency,
  href,
  percent,
  emphasis,
  indent,
  muted,
}: {
  label: string;
  value: number;
  currency: string;
  href?: string;
  percent?: number | null;
  emphasis?: "subtotal" | "total";
  indent?: boolean;
  muted?: boolean;
}) {
  const labelNode = href ? (
    <Link href={href} className="text-[var(--color-accent-strong)]">
      {label}
    </Link>
  ) : (
    <span>{label}</span>
  );

  return (
    <div
      className={`flex items-center gap-3 ${
        emphasis === "subtotal"
          ? "border-t border-[var(--color-hairline-soft)] py-3"
          : emphasis === "total"
            ? "border-t border-[var(--color-hairline)] py-3"
            : "py-[7px]"
      } ${indent ? "pl-4" : ""}`}
    >
      <div
        className={`flex-1 ${
          emphasis
            ? "text-[14px] font-semibold text-[var(--color-ink)]"
            : muted
              ? "text-[12.5px] text-[var(--color-muted)]"
              : "text-[13px] text-[var(--color-ink-2)]"
        }`}
      >
        {labelNode}
      </div>
      <div className="w-16 text-right font-mono text-[11px] text-[var(--color-faint)]">
        {percent !== null && percent !== undefined ? `${percent.toFixed(0)}%` : ""}
      </div>
      <Money
        value={value}
        currency={currency}
        className={`w-[140px] text-right ${
          emphasis === "total"
            ? "text-[15px] font-semibold text-[var(--color-ink)]"
            : emphasis === "subtotal"
              ? "text-[14px] font-semibold text-[var(--color-ink)]"
              : "text-[13px] text-[var(--color-ink)]"
        }`}
      />
    </div>
  );
}

export default async function MonthlyResultReportPage({
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
  // getCompanyForEdit doubles as the membership check here, same
  // pattern as the Projects page.
  const membership = await getCompanyForEdit(id);

  if (!membership) {
    redirect("/companies");
  }

  const period = MONTH_PATTERN.test(periodParam ?? "")
    ? (periodParam as string)
    : currentMonth();
  const periodDate = `${period}-01`;
  const currency = membership.company.currency;

  const [series, breakdown] = await Promise.all([
    getMonthlySeries(id, periodDate, 12),
    getProfitabilityBreakdown(id, periodDate),
  ]);

  const result = series[series.length - 1];

  // Story 6.4: drill-down links use the exact same [start, end) range
  // the calculation summed over, so the filtered list's sum reconciles
  // with the figure. `voided=exclude` matches netSales' own exclusion
  // of voided sales documents.
  const { start, end } = monthRange(periodDate);
  const salesHref = `/companies/${id}/sales?from=${start}&to=${end}&voided=exclude`;
  const directCostsHref = `/companies/${id}/costs?from=${start}&to=${end}&classification=direct`;
  const generalCostsHref = `/companies/${id}/costs?from=${start}&to=${end}&classification=general`;

  const pct = (value: number) =>
    result.netSales !== 0 ? (value / result.netSales) * 100 : 0;

  const maxOpResult = Math.max(1, ...series.map((p) => Math.abs(p.operatingResult)));
  const areasByMargin = [...breakdown.areas].sort((a, b) => b.margin - a.margin);

  return (
    <div className="flex flex-col gap-[18px]">
      <PageHeader
        eyebrow="ANÁLISIS / RESULTADO MENSUAL"
        title="Estado de resultados de gestión"
        subtitle={membership.company.name}
        actions={
          <PeriodPicker
            period={period}
            basePath={`/companies/${id}/reports/monthly-result`}
          />
        }
      />

      {result.hasError || breakdown.hasError ? <DataIncompleteBanner /> : null}

      <div className="grid grid-cols-1 gap-3.5 lg:grid-cols-[1.5fr_1fr]">
        <Card padding="24px 26px 20px">
          <div className="mb-2 flex items-baseline justify-between border-b border-[var(--color-hairline-soft)] pb-3">
            <h2 className="text-[15px] font-semibold text-[var(--color-ink)]">
              Estado de resultados de gestión
            </h2>
            <span className="font-mono text-[10.5px] text-[var(--color-muted)]">
              EN {currency} · {period.slice(5, 7)}/{period.slice(0, 4)}
            </span>
          </div>

          <div className="flex flex-col">
            <IncomeRow
              label="Ventas netas"
              value={result.netSales}
              currency={currency}
              href={salesHref}
              percent={100}
            />
            <IncomeRow
              label="Facturas y recibos"
              value={result.netSales}
              currency={currency}
              indent
              muted
            />
            <IncomeRow
              label="Costos directos"
              value={result.directCosts}
              currency={currency}
              href={directCostsHref}
              percent={pct(result.directCosts)}
            />
            <IncomeRow
              label="Margen directo"
              value={result.directMargin}
              currency={currency}
              percent={pct(result.directMargin)}
              emphasis="subtotal"
            />
            <IncomeRow
              label="Costos generales"
              value={result.generalCosts}
              currency={currency}
              href={generalCostsHref}
              percent={pct(result.generalCosts)}
            />
            <IncomeRow
              label="Documentos de costo"
              value={result.generalCostDocuments}
              currency={currency}
              indent
              muted
            />
            <IncomeRow
              label="Personal"
              value={result.generalPersonnelCosts}
              currency={currency}
              indent
              muted
            />
          </div>

          <div className="mt-4 flex items-center justify-between rounded-lg border border-[var(--color-accent-soft-border)] bg-[var(--color-accent-soft)] px-[18px] py-4">
            <div className="flex flex-col gap-0.5">
              <span className="text-[13px] font-semibold text-[var(--color-accent-strong)]">
                Resultado operativo
              </span>
              <span className="text-[12px] text-[var(--color-accent-muted)]">
                Margen directo menos costos generales del período.
              </span>
            </div>
            <Money
              value={result.operatingResult}
              currency={currency}
              className="text-[27px] font-semibold text-[var(--color-accent-strong)]"
            />
          </div>
        </Card>

        <div className="flex flex-col gap-3.5">
          <Card padding="18px 20px 16px">
            <h3 className="mb-3 text-[13px] font-semibold text-[var(--color-ink)]">
              Resultado operativo · 12 meses
            </h3>
            <svg viewBox="0 0 380 120" className="w-full">
              {series.map((point, i) => {
                const barWidth = 20;
                const gap = 380 / series.length;
                const x = gap * i + (gap - barWidth) / 2;
                const height = (Math.abs(point.operatingResult) / maxOpResult) * 90;
                const isCurrent = i === series.length - 1;
                return (
                  <rect
                    key={point.period}
                    x={x}
                    y={100 - height}
                    width={barWidth}
                    height={height}
                    rx={2}
                    fill={isCurrent ? "var(--color-accent)" : "var(--color-neutral-bar)"}
                  />
                );
              })}
              <line x1={0} y1={100} x2={380} y2={100} stroke="var(--color-hairline)" />
            </svg>
          </Card>

          <Card padding="18px 20px 16px">
            <h3 className="mb-3 text-[13px] font-semibold text-[var(--color-ink)]">
              Margen por área de negocio
            </h3>
            {areasByMargin.length === 0 ? (
              <p className="text-[12.5px] text-[var(--color-muted)]">
                No hay áreas de negocio.
              </p>
            ) : (
              <div className="flex flex-col gap-2.5">
                {areasByMargin.map((area) => {
                  const maxMargin = Math.max(
                    1,
                    ...areasByMargin.map((a) => Math.abs(a.margin)),
                  );
                  const pctWidth = (Math.abs(area.margin) / maxMargin) * 100;
                  return (
                    <div key={area.id} className="flex flex-col gap-1">
                      <div className="flex items-center justify-between text-[12.5px]">
                        <span className="text-[var(--color-ink-2)]">{area.name}</span>
                        <Money value={area.margin} currency={currency} showCurrency={false} />
                      </div>
                      <div className="h-[5px] w-full rounded-full bg-[var(--color-hairline-soft)]">
                        <div
                          className="h-[5px] rounded-full bg-[var(--color-accent-bright)]"
                          style={{ width: `${pctWidth}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>

          {result.pendingProjectCount > 0 ? (
            <div className="flex flex-col gap-1 rounded-[10px] border border-[var(--color-warning-soft-border)] bg-[var(--color-warning-panel)] px-4 py-3">
              <span className="text-[13px] font-semibold text-[var(--color-warning-ink-2)]">
                {result.pendingProjectCount} proyecto
                {result.pendingProjectCount === 1 ? "" : "s"} sin costo
              </span>
              <span className="text-[12.5px] text-[var(--color-warning-ink)]">
                El resultado confirmado puede bajar una vez cargado.
              </span>
              <Link
                href={`/companies/${id}/projects`}
                className="text-[13px] font-medium text-[var(--color-warning-ink-2)]"
              >
                Revisar proyectos →
              </Link>
            </div>
          ) : null}
        </div>
      </div>

      <Link
        href={`/companies/${id}/reports/profitability`}
        className="text-[13px] font-medium text-[var(--color-accent-strong)]"
      >
        Ver rentabilidad por cliente, proyecto y área
      </Link>
    </div>
  );
}
