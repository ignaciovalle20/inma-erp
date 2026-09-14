"use client";

import { useEffect, useRef, useState } from "react";

const MONTH_LABELS = [
  "Ene",
  "Feb",
  "Mar",
  "Abr",
  "May",
  "Jun",
  "Jul",
  "Ago",
  "Sep",
  "Oct",
  "Nov",
  "Dic",
];

function parsePeriod(value: string): { year: number; month: number } | null {
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  return { year, month };
}

function formatPeriod(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}`;
}

function formatDisplay(value: string): string {
  const parsed = parsePeriod(value);
  if (!parsed) return "";
  return `${MONTH_LABELS[parsed.month - 1]} ${parsed.year}`;
}

/**
 * Month + year picker, deliberately with no day-level granularity --
 * for filtering ventas/costos to one calendar month, where picking a
 * specific day never made sense. Posts the same "YYYY-MM" string a
 * native <input type="month"> would via a hidden input (so it drops
 * into the existing GET filter form unchanged), but with a consistent
 * look across browsers -- native month inputs render very differently
 * (Firefox has no picker UI for type="month" at all).
 */
export function MonthPicker({
  name,
  defaultValue,
  placeholder = "Mes",
  className = "",
}: {
  name: string;
  defaultValue?: string;
  placeholder?: string;
  className?: string;
}) {
  const today = new Date();
  const [value, setValue] = useState(
    defaultValue ?? formatPeriod(today.getFullYear(), today.getMonth() + 1),
  );
  const [open, setOpen] = useState(false);
  const initial = parsePeriod(defaultValue ?? "");
  const [viewYear, setViewYear] = useState(initial?.year ?? today.getFullYear());
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const selected = parsePeriod(value);

  return (
    <div ref={containerRef} className="relative">
      <input type="hidden" name={name} value={value} />
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={
          className ||
          "rounded-lg border border-[var(--color-hairline)] bg-white px-3 py-[7px] text-left text-[13px] outline-none focus:border-[var(--color-ink)]"
        }
      >
        {value ? (
          <span className="text-[var(--color-ink)]">{formatDisplay(value)}</span>
        ) : (
          <span className="text-[var(--color-faint)]">{placeholder}</span>
        )}
      </button>
      {open ? (
        <div className="absolute left-0 top-[calc(100%+4px)] z-20 w-[220px] rounded-[10px] border border-[var(--color-hairline)] bg-white p-3 shadow-lg">
          <div className="mb-2 flex items-center justify-between">
            <button
              type="button"
              onClick={() => setViewYear((y) => y - 1)}
              className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--color-muted)] hover:bg-[var(--color-row)] hover:text-[var(--color-ink)]"
              aria-label="Año anterior"
            >
              ‹
            </button>
            <span className="font-mono text-[12px] font-semibold text-[var(--color-ink)]">
              {viewYear}
            </span>
            <button
              type="button"
              onClick={() => setViewYear((y) => y + 1)}
              className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--color-muted)] hover:bg-[var(--color-row)] hover:text-[var(--color-ink)]"
              aria-label="Año siguiente"
            >
              ›
            </button>
          </div>
          <div className="grid grid-cols-3 gap-1">
            {MONTH_LABELS.map((label, i) => {
              const month = i + 1;
              const isSelected = selected?.year === viewYear && selected.month === month;
              const isCurrent = today.getFullYear() === viewYear && today.getMonth() + 1 === month;
              return (
                <button
                  key={label}
                  type="button"
                  onClick={() => {
                    setValue(formatPeriod(viewYear, month));
                    setOpen(false);
                  }}
                  className={`rounded-md px-2 py-1.5 font-mono text-[12px] ${
                    isSelected
                      ? "bg-[var(--color-accent)] text-white hover:bg-[var(--color-accent-strong)]"
                      : isCurrent
                        ? "font-bold text-[var(--color-accent-strong)] hover:bg-[var(--color-row)]"
                        : "text-[var(--color-ink-2)] hover:bg-[var(--color-row)]"
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>
          {value ? (
            <button
              type="button"
              onClick={() => {
                setValue("");
                setOpen(false);
              }}
              className="mt-2 w-full rounded-md px-2 py-1 text-center text-[11.5px] text-[var(--color-muted)] hover:text-[var(--color-ink)]"
            >
              Quitar
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
