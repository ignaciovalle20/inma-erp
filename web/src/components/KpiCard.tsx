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
      <div className="flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-[0.13em] text-[var(--color-muted)]">
          {label}
        </span>
        {delta !== null ? (
          <span
            className={`font-mono text-[10.5px] font-medium ${
              isFavorable
                ? "text-[var(--color-accent-strong)]"
                : "text-[var(--color-negative-ink)]"
            }`}
          >
            {isUp ? "+" : ""}
            {delta.toFixed(1)}%
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
        <span className="text-[11.5px] text-[var(--color-muted)]">
          {footer}
        </span>
      ) : null}
    </>
  );

  const className =
    "flex flex-col gap-2 rounded-[10px] border border-[var(--color-hairline)] bg-[var(--color-surface)] px-4 pt-4 pb-3.5 no-underline";

  if (href) {
    return (
      <Link href={href} className={`${className} hover:border-[var(--color-accent)]`}>
        {content}
      </Link>
    );
  }

  return <div className={className}>{content}</div>;
}
