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
}: {
  period: string;
  basePath: string;
}) {
  const router = useRouter();
  const prev = shiftPeriod(period, -1);
  const next = shiftPeriod(period, 1);

  return (
    <div className="flex items-center rounded-lg border border-[var(--color-hairline)] bg-[var(--color-surface)]">
      <Link
        href={`${basePath}?period=${prev}`}
        className="px-2.5 py-[7px] text-[var(--color-muted)] no-underline hover:text-[var(--color-ink)]"
        aria-label="Mes anterior"
      >
        ◂
      </Link>
      <label className="relative flex items-center px-1">
        <span className="pointer-events-none px-1 font-mono text-[12.5px] font-medium text-[var(--color-ink)]">
          {label(period)}
        </span>
        <input
          type="month"
          defaultValue={period}
          onChange={(event) => {
            if (event.target.value) {
              router.push(`${basePath}?period=${event.target.value}`);
            }
          }}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
          aria-label="Elegir mes"
        />
      </label>
      <Link
        href={`${basePath}?period=${next}`}
        className="px-2.5 py-[7px] text-[var(--color-muted)] no-underline hover:text-[var(--color-ink)]"
        aria-label="Mes siguiente"
      >
        ▸
      </Link>
    </div>
  );
}
