import { Money } from "@/components/Money";
import type { MoneySummary } from "@/lib/multiCurrency";

/**
 * How every summary shows a MoneySummary (lib/multiCurrency.ts): the
 * subtotal of each currency in that currency, then the combined total in
 * the company's currency and in USD. A combined total that is missing an
 * exchange rate says so ("incompleto") instead of showing a lower figure as
 * if it were complete.
 *
 * - `variant="lines"`: one line per figure, for cards and footers.
 * - `variant="inline"`: a single wrapped line, for chips and table footers.
 * - `showSubtotals`: per-currency lines; by default only when there is
 *   more than one currency or the only one is not the local one.
 */
export function MoneyBreakdown({
  summary,
  label = "Total",
  variant = "lines",
  showSubtotals,
  subtotalLabel,
  hideLocalTotal = false,
  className = "",
}: {
  /** When the local total is already shown big right above (a KPI card). */
  hideLocalTotal?: boolean;
  summary: MoneySummary;
  label?: string;
  variant?: "lines" | "inline";
  showSubtotals?: boolean;
  /** Prefix of each per-currency line, e.g. "Facturado" -> "Facturado USD". */
  subtotalLabel?: string;
  className?: string;
}) {
  const local = summary.localCurrency;
  const subtotals =
    showSubtotals ??
    (summary.byCurrency.length > 1 ||
      (summary.byCurrency.length === 1 && summary.byCurrency[0].currency !== local));
  const incomplete = (
    <span
      className="ml-1 rounded border border-[var(--color-warning-soft-border)] bg-[var(--color-warning-soft)] px-1 font-sans text-[10.5px] font-medium text-[var(--color-warning-ink)]"
      title="Falta el tipo de cambio de alguna fecha: este total no incluye esos montos"
    >
      incompleto
    </span>
  );

  const totals = (
    <>
      {hideLocalTotal ? null : (
        <span className="whitespace-nowrap">
          <Money value={summary.local} currency={local} />
          {summary.localComplete ? null : incomplete}
        </span>
      )}
      {local === "USD" ? null : (
        <span className="whitespace-nowrap">
          <Money value={summary.usd} currency="USD" />
          {summary.usdComplete ? null : incomplete}
        </span>
      )}
    </>
  );

  if (variant === "inline") {
    return (
      <span className={`inline-flex flex-wrap items-center gap-x-2 gap-y-0.5 ${className}`}>
        {subtotals
          ? summary.byCurrency.map((subtotal) => (
              <span key={subtotal.currency} className="whitespace-nowrap">
                {subtotalLabel ? `${subtotalLabel} ` : ""}
                <Money value={subtotal.amount} currency={subtotal.currency} />
              </span>
            ))
          : null}
        <span className="text-[var(--color-faint)]">{label}:</span>
        {totals}
      </span>
    );
  }

  return (
    <div className={`flex flex-col gap-0.5 text-[12px] text-[var(--color-muted)] ${className}`}>
      {subtotals
        ? summary.byCurrency.map((subtotal) => (
            <div key={subtotal.currency} className="flex items-center justify-between gap-3">
              <span>
                {subtotalLabel ?? "En"} {subtotal.currency}
              </span>
              <Money value={subtotal.amount} currency={subtotal.currency} />
            </div>
          ))
        : null}
      <div className="flex flex-wrap items-center justify-between gap-x-3">
        <span>{label}</span>
        <span className="flex flex-wrap items-center justify-end gap-x-2">{totals}</span>
      </div>
    </div>
  );
}
