"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";

const MONTH_LABELS = [
  "ENE",
  "FEB",
  "MAR",
  "ABR",
  "MAY",
  "JUN",
  "JUL",
  "AGO",
  "SEP",
  "OCT",
  "NOV",
  "DIC",
];

function shiftPeriod(period: string, delta: number): string {
  const [year, month] = period.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1 + delta, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function label(period: string): string {
  const [year, month] = period.split("-").map(Number);
  return `${MONTH_LABELS[month - 1]} ${year}`;
}

export function PeriodPicker({
  period,
  basePath,
  min,
  max,
  query = "",
}: {
  period: string;
  basePath: string;
  /** Optional bounds ("YYYY-MM"): the arrows stop there. */
  min?: string;
  max?: string;
  /** Extra query string kept on every link (e.g. "&pendientes=1"). */
  query?: string;
}) {
  const router = useRouter();
  const prev = shiftPeriod(period, -1);
  const next = shiftPeriod(period, 1);
  const canPrev = !min || prev >= min;
  const canNext = !max || next <= max;
  const arrow = "px-2.5 py-[7px] text-[var(--color-muted)] no-underline";

  return (
    <div className="flex items-center rounded-lg border border-[var(--color-hairline)] bg-[var(--color-surface)]">
      {canPrev ? (
        <Link
          href={`${basePath}?period=${prev}${query}`}
          className={`${arrow} hover:text-[var(--color-ink)]`}
          aria-label="Mes anterior"
        >
          ◂
        </Link>
      ) : (
        <span className={`${arrow} opacity-30`} aria-hidden="true">
          ◂
        </span>
      )}
      <label className="relative flex items-center px-1">
        <span className="pointer-events-none px-1 font-mono text-[12.5px] font-medium text-[var(--color-ink)]">
          {label(period)}
        </span>
        <input
          type="month"
          defaultValue={period}
          min={min}
          max={max}
          onChange={(event) => {
            if (event.target.value) {
              router.push(`${basePath}?period=${event.target.value}${query}`);
            }
          }}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
          aria-label="Elegir mes"
        />
      </label>
      {canNext ? (
        <Link
          href={`${basePath}?period=${next}${query}`}
          className={`${arrow} hover:text-[var(--color-ink)]`}
          aria-label="Mes siguiente"
        >
          ▸
        </Link>
      ) : (
        <span className={`${arrow} opacity-30`} aria-hidden="true">
          ▸
        </span>
      )}
    </div>
  );
}
