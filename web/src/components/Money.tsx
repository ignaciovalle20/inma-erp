import { currencyDecimals } from "@/lib/currencies";

// "de-DE" gives "." for thousands and "," for decimals, and always groups
// (the "es" locales skip the separator on 4-digit numbers).
const NUMBER_LOCALE = "de-DE";

export function formatDecimal(value: number, decimals: number): string {
  return value.toLocaleString(NUMBER_LOCALE, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export function formatAmount(amount: number, currency: string): string {
  return formatDecimal(amount, currencyDecimals(currency));
}

export function Money({
  value,
  currency,
  className = "",
  negativeClassName = "text-[var(--color-negative-ink)]",
  showCurrency = true,
}: {
  value: number;
  currency: string;
  className?: string;
  negativeClassName?: string;
  showCurrency?: boolean;
}) {
  const isNegative = value < 0;
  return (
    <span
      className={`font-mono tabular-nums ${isNegative ? negativeClassName : ""} ${className}`}
    >
      {formatAmount(value, currency)}
      {showCurrency ? (
        <span className="ml-1 text-[var(--color-faint)]">{currency}</span>
      ) : null}
    </span>
  );
}
