function localeFor(currency: string): string {
  if (currency === "UYU") return "es-UY";
  if (currency === "CLP") return "es-CL";
  return "en-US";
}

export function formatAmount(amount: number, currency: string): string {
  return amount.toLocaleString(localeFor(currency), {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
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
