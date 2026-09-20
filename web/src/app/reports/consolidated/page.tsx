import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession, getUserCompanies } from "@/lib/dal";
import { computeConsolidatedResult } from "@/lib/reporting";
import { PageHeader } from "@/components/PageHeader";
import { PeriodPicker } from "@/components/PeriodPicker";
import { Card } from "@/components/Card";
import { Money } from "@/components/Money";
import { EmptyState } from "@/components/EmptyState";
import { AppShell } from "@/components/AppShell";
import { DataIncompleteBanner } from "@/components/DataIncompleteBanner";
import { MONTH_PATTERN } from "@/lib/period";

function currentMonth(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Story 6.5: Consolidated Chile + Uruguay Result in USD.
 *
 * Top-level (not company-scoped) report -- includes every company the
 * viewer is a member of, per spec Boundaries. A company whose
 * currency's rate couldn't be resolved shows a "pending exchange rate"
 * notice instead of being silently omitted or shown as zero.
 */
export default async function ConsolidatedReportPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>;
}) {
  const { period: periodParam } = await searchParams;
  const user = await getSession();

  if (!user) {
    redirect("/login");
  }

  const period = MONTH_PATTERN.test(periodParam ?? "")
    ? (periodParam as string)
    : currentMonth();
  const periodDate = `${period}-01`;

  const [consolidated, companies] = await Promise.all([
    computeConsolidatedResult(periodDate),
    getUserCompanies(),
  ]);

  return (
    <AppShell
      companies={companies.map((company) => ({
        id: company.id,
        name: company.name,
        currency: company.currency,
      }))}
      userEmail={user.email ?? ""}
    >
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6">
      <PageHeader
        eyebrow="ANÁLISIS / CONSOLIDADO"
        title="Consolidado USD"
        subtitle="Todas tus empresas, convertidas a USD y sumadas"
        actions={<PeriodPicker period={period} basePath="/reports/consolidated" />}
      />

      {consolidated.hasError ? <DataIncompleteBanner /> : null}

      {consolidated.companies.length === 0 ? (
        <Card>
          <EmptyState message="No tenés acceso a ninguna empresa todavía." />
        </Card>
      ) : (
        <>
          <div className="flex flex-col gap-3">
            {consolidated.companies.map((company) => (
              <Card key={company.companyId} className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <span className="text-[13.5px] font-semibold text-[var(--color-ink)]">
                    {company.companyName}
                  </span>
                  <Money
                    value={company.result.operatingResult}
                    currency={company.currency}
                    className="text-[13px] text-[var(--color-ink-2)]"
                  />
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[12.5px] text-[var(--color-muted)]">
                    Resultado operativo en USD
                  </span>
                  {company.usdAmount !== null ? (
                    <Money
                      value={company.usdAmount}
                      currency="USD"
                      className="font-semibold text-[var(--color-ink)]"
                    />
                  ) : (
                    <span className="text-[var(--color-faint)]">—</span>
                  )}
                </div>
                {company.ratePending ? (
                  <div className="rounded-lg border border-[var(--color-warning-soft-border)] bg-[var(--color-warning-soft)] px-3 py-2 text-[12px] text-[var(--color-warning-ink)]">
                    Tipo de cambio pendiente -- no se pudo obtener la
                    cotización y no hay un valor guardado para este período.
                  </div>
                ) : null}
              </Card>
            ))}
          </div>

          <div className="flex items-center justify-between rounded-[10px] border border-[var(--color-accent-soft-border)] bg-[var(--color-accent-soft)] px-4 py-3.5">
            <span className="text-[13px] font-semibold text-[var(--color-accent-strong)]">
              Total (USD)
            </span>
            <Money
              value={consolidated.totalUsd}
              currency="USD"
              className="text-[19px] font-semibold text-[var(--color-accent-strong)]"
            />
          </div>

          {consolidated.pendingRateCompanies.length > 0 ? (
            <p className="text-[11.5px] text-[var(--color-muted)]">
              El total excluye a{" "}
              {consolidated.pendingRateCompanies
                .map((company) => company.companyName)
                .join(", ")}{" "}
              -- tipo de cambio pendiente, no se cuenta como cero.
            </p>
          ) : null}
        </>
      )}

      <Link
        href="/companies"
        className="text-[13px] text-[var(--color-muted)] hover:text-[var(--color-ink)]"
      >
        Volver a empresas
      </Link>
    </div>
    </AppShell>
  );
}
