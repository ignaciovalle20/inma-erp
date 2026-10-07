import Link from "next/link";
import { getRecurringServiceOccurrencesForMonth } from "@/lib/dal";
import { monthLabel } from "@/lib/period";
import { isOverdue, todayForCountry } from "@/lib/recurringServicePending";

/**
 * Dashboard card: this month's recurring-service cycles of the active
 * company (the same ones the Tablero del mes shows) -- how many are still
 * to invoice, to collect, and overdue -- linking to that board. Always the
 * current month in the company's time zone, independent of the
 * dashboard's own period picker.
 */
export async function RecurringServicesMonthCard({
  companyId,
  country,
}: {
  companyId: string;
  country: string | null;
}) {
  const today = todayForCountry(country);
  const month = today.slice(0, 7);
  const cycles = await getRecurringServiceOccurrencesForMonth(companyId, month);

  const toInvoice = cycles.filter((c) => c.status === "pending_invoice").length;
  const toCollect = cycles.filter((c) => c.status === "invoiced" || c.status === "pending_collection").length;
  const overdue = cycles.filter((c) => isOverdue(c, today)).length;

  const stats = [
    { label: "Por facturar", value: toInvoice, tone: "text-[var(--color-ink)]" },
    { label: "Por cobrar", value: toCollect, tone: "text-[var(--color-warning-ink)]" },
    {
      label: "Vencidos",
      value: overdue,
      tone: overdue > 0 ? "text-[var(--color-negative-ink)]" : "text-[var(--color-ink)]",
    },
  ];

  return (
    <Link
      href={`/companies/${companyId}/recurring-services`}
      aria-label={`Servicios del mes: ${toInvoice} por facturar, ${toCollect} por cobrar, ${overdue} vencidos. Ir al tablero.`}
      className="flex flex-col gap-2.5 rounded-[10px] border border-[var(--color-hairline)] bg-[var(--color-surface)] px-[18px] py-3.5 text-[var(--color-ink)] no-underline hover:border-[var(--color-border-hover)]"
    >
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-[13.5px] font-semibold">Servicios del mes</h2>
        <span className="caps-label text-[var(--color-muted)]">
          {monthLabel(month)} · ver tablero →
        </span>
      </div>
      <dl className="grid grid-cols-3 gap-3">
        {stats.map((stat) => (
          <div key={stat.label} className="flex flex-col gap-0.5">
            <dt className="text-[11.5px] text-[var(--color-muted)]">{stat.label}</dt>
            <dd className={`font-mono text-[20px] font-medium tabular-nums ${stat.tone}`}>{stat.value}</dd>
          </div>
        ))}
      </dl>
    </Link>
  );
}
