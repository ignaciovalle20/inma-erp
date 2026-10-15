import { MoneyBreakdown } from "@/components/MoneyBreakdown";
import { summarizeMoney, type RateTable } from "@/lib/multiCurrency";
import { isOverdue } from "@/lib/recurringServicePending";

type Cycle = {
  status: string;
  amount: number;
  currency: string;
  period: string;
  invoiced_at: string | null;
  invoice_due_date: string | null;
  collection_due_date: string | null;
};

/**
 * The per-currency cards of the recurring services screens, combined: each
 * figure (por facturar, por cobrar, vencido, cobrado) in the company's
 * currency and in USD, every cycle converted with the rate of its own date
 * (the shared helper, lib/multiCurrency.ts). Only shown when there is more
 * than one currency, or one that is not the company's: otherwise the
 * per-currency card already is the total.
 */
export function RecurringCombinedTotals({
  cycles,
  localCurrency,
  rates,
  today,
}: {
  cycles: Cycle[];
  localCurrency: string;
  rates: RateTable;
  today?: string;
}) {
  const live = cycles.filter((cycle) => cycle.status !== "void");
  const currencies = new Set(live.map((cycle) => cycle.currency));
  if (currencies.size === 0 || (currencies.size === 1 && currencies.has(localCurrency))) return null;

  const summary = (list: Cycle[]) =>
    summarizeMoney(
      list.map((cycle) => ({
        amount: Number(cycle.amount),
        currency: cycle.currency,
        date: cycle.invoiced_at ?? cycle.invoice_due_date ?? cycle.period,
      })),
      localCurrency,
      rates,
    );

  const figures = [
    { label: "Por facturar", list: live.filter((cycle) => cycle.status === "pending_invoice") },
    {
      label: "Por cobrar",
      list: live.filter((cycle) => cycle.status !== "pending_invoice" && cycle.status !== "collected"),
    },
    ...(today ? [{ label: "Vencido", list: live.filter((cycle) => isOverdue(cycle, today)) }] : []),
    { label: "Cobrado", list: live.filter((cycle) => cycle.status === "collected") },
  ];

  return (
    <div className="flex flex-col gap-1.5 rounded-[10px] border border-[var(--color-accent-soft-border)] bg-[var(--color-accent-soft)] p-3">
      <p className="caps-label text-[var(--color-accent-muted)]">Total combinado · {localCurrency} y USD</p>
      <dl className="grid gap-1 text-[12px]">
        {figures.map((figure) => (
          <div key={figure.label} className="flex flex-wrap items-center justify-between gap-x-3">
            <dt className="text-[var(--color-muted)]">{figure.label}</dt>
            <dd>
              <MoneyBreakdown summary={summary(figure.list)} variant="inline" label="" showSubtotals={false} />
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
