import Link from "next/link";
import { Money } from "@/components/Money";

export function KpiCard({
  label,
  value,
  currency,
  href,
  previousValue,
  favorableWhen = "up",
  proportion,
  footer,
}: {
  label: string;
  value: number;
  currency: string;
  href?: string;
  previousValue?: number;
  favorableWhen?: "up" | "down";
  proportion?: number;
  footer?: string;
}) {
  const delta =
    previousValue !== undefined && previousValue !== 0
      ? ((value - previousValue) / Math.abs(previousValue)) * 100
      : null;
  const isUp = delta !== null && delta > 0;
  const isFavorable =
    delta !== null &&
    delta !== 0 &&
    (favorableWhen === "up" ? isUp : !isUp);

  const content = (
    <>
      <div className="flex items-center justify-between gap-2">
        <span className="caps-label min-w-0 truncate text-[var(--color-muted)]">
          {label}
        </span>
        {delta !== null ? (
          <span
            className={`flex-none font-mono text-caption font-medium tabular-nums ${
              isFavorable
                ? "text-[var(--color-accent-strong)]"
                : "text-[var(--color-negative-ink)]"
            }`}
          >
            {isUp ? "+" : ""}
            {delta.toFixed(1).replace(".", ",")}%
          </span>
        ) : null}
      </div>
      <Money
        value={value}
        currency={currency}
        showCurrency
        className="text-[25px] font-semibold text-[var(--color-ink)]"
      />
      {proportion !== undefined ? (
        <div className="h-[3px] w-full rounded-full bg-[var(--color-hairline-soft)]">
          <div
            className="h-[3px] rounded-full bg-[var(--color-accent)]"
            style={{ width: `${Math.max(0, Math.min(100, proportion * 100))}%` }}
          />
        </div>
      ) : null}
      {footer ? (
        <span className="text-small text-[var(--color-muted)]">
          {footer}
        </span>
      ) : null}
    </>
  );

  const className = "surface-card flex min-w-0 flex-col gap-2 p-4 no-underline";

  if (href) {
    return (
      <Link href={href} className={`${className} card-interactive text-[var(--color-ink)] hover:text-[var(--color-ink)]`}>
        {content}
      </Link>
    );
  }

  return <div className={className}>{content}</div>;
}
