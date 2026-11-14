import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession, getCompanyForEdit } from "@/lib/dal";
import { getProfitabilityReport } from "@/lib/projectProfitability";
import { Money } from "@/components/Money";
import { PageHeader } from "@/components/PageHeader";
import { ProfitabilityTabs, TotalsNotes } from "@/components/ProfitabilityTabs";
import { DataIncompleteBanner } from "@/components/DataIncompleteBanner";
import { formatPeriod } from "@/lib/period";

/** Green when positive, red when negative, as on the job's page. */
function signTone(value: number): string {
  if (value === 0) return "text-[var(--color-ink)]";
  return value > 0 ? "text-[var(--color-accent-strong)]" : "text-[var(--color-negative-ink)]";
}

export default async function ProfitabilityReportPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
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

  const currency = membership.company.currency;
  // Every job with the six figures of its own page (lib/projectSummary), and
  // the jobs added up in the company's currency.
  const report = await getProfitabilityReport(id, currency);
  const company = report.company;

  const volver = encodeURIComponent(`/companies/${id}/reports/profitability`);
  const projects = report.projects.map((row) => ({
    id: row.id,
    name: row.name,
    href: `/companies/${id}/projects/${row.id}?volver=${volver}`,
    clientName: row.clientName,
    summary: row.summary,
  }));
  const months = report.months.map((group) => ({ ...group, name: formatPeriod(`${group.id}-01`) }));

  const cards: { label: string; value: number; signed?: boolean }[] = [
    { label: "Total cotizado", value: company.quoted },
    { label: "Total facturado", value: company.billed },
    { label: "Total gastos", value: company.expenses },
    { label: "Total técnicos", value: company.technicians },
    { label: "Margen", value: company.margin, signed: true },
  ];

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <PageHeader
        eyebrow="ANÁLISIS / RENTABILIDAD"
        title="Rentabilidad por trabajo, cliente, área y mes"
        subtitle={membership.company.name}
      />

      {report.errors.length > 0 ? <DataIncompleteBanner details={report.errors} /> : null}

      <section aria-label="Total de la empresa" className="flex flex-col gap-2">
        <h2 className="text-[12.5px] font-semibold uppercase tracking-[0.08em] text-[var(--color-muted)]">
          Total de la empresa
          <span className="ml-1.5 font-normal normal-case tracking-normal">
            · {company.jobs} {company.jobs === 1 ? "trabajo" : "trabajos"}, neto sin IVA, en {currency}
          </span>
        </h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {cards.map((card) => (
            <div
              key={card.label}
              className="flex flex-col gap-1 rounded-[10px] border border-[var(--color-hairline)] bg-[var(--color-surface)] p-3"
            >
              <span className="caps-label text-[var(--color-muted)]">{card.label}</span>
              <Money
                value={card.value}
                currency={currency}
                showCurrency={false}
                className={`text-[15px] ${card.signed ? signTone(card.value) : ""}`}
                negativeClassName={card.signed ? "" : undefined}
              />
            </div>
          ))}
          <div className="flex flex-col gap-1 rounded-[10px] border border-[var(--color-hairline)] bg-[var(--color-surface)] p-3">
            <span className="caps-label text-[var(--color-muted)]" title="Margen / facturado × 100.">
              Margen %
            </span>
            <span
              className={`font-mono text-[15px] tabular-nums ${company.marginPct === null ? "text-[var(--color-muted)]" : signTone(company.marginPct)}`}
            >
              {company.marginPct === null
                ? "—"
                : `${company.marginPct.toLocaleString("es", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`}
            </span>
          </div>
        </div>
        <TotalsNotes totals={company} />
      </section>

      <p className="text-[12px] text-[var(--color-muted)]">
        Cifras acumuladas de cada trabajo, netas (sin IVA): las mismas de su ficha. Técnicos va aparte de Gastos y no
        se cuenta dos veces. Los totales por cliente, área, mes y empresa suman los trabajos en {currency}; lo que
        está en otra moneda se convierte con el tipo de cambio del mes del trabajo y se avisa. Los servicios
        recurrentes y las ventas sin trabajo no entran acá: están en el resultado mensual.
      </p>

      <ProfitabilityTabs
        currency={currency}
        projects={projects}
        clients={report.clients}
        areas={report.areas}
        months={months}
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
