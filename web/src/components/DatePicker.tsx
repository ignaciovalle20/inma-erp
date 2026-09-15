"use client";

import { useEffect, useRef, useState } from "react";
import { DayPicker } from "react-day-picker";
import { es } from "react-day-picker/locale";

/** "YYYY-MM-DD" <-> local Date, without any UTC-shift surprises. */
function parseDateValue(value: string): Date | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function formatDateValue(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatDisplay(value: string): string {
  const date = parseDateValue(value);
  if (!date) return "";
  return new Intl.DateTimeFormat("es", { day: "2-digit", month: "short", year: "numeric" }).format(date);
}

const calendarClassNames = {
  root: "font-sans text-[13px]",
  months: "flex flex-col",
  month: "flex flex-col gap-2",
  month_caption: "flex items-center justify-center px-8 py-1.5 relative",
  caption_label: "font-mono text-[12px] font-semibold uppercase tracking-[0.06em] text-[var(--color-ink)]",
  nav: "flex items-center justify-between absolute inset-x-1 top-1",
  button_previous:
    "flex h-7 w-7 items-center justify-center rounded-md text-[var(--color-muted)] hover:bg-[var(--color-row)] hover:text-[var(--color-ink)]",
  button_next:
    "flex h-7 w-7 items-center justify-center rounded-md text-[var(--color-muted)] hover:bg-[var(--color-row)] hover:text-[var(--color-ink)]",
  month_grid: "w-full border-collapse",
  weekdays: "flex",
  weekday: "w-8 pb-1 text-center font-mono text-[9.5px] uppercase tracking-[0.06em] text-[var(--color-faint)]",
  week: "flex",
  day: "h-8 w-8 p-0 text-center align-middle",
  day_button:
    "flex h-8 w-8 items-center justify-center rounded-md font-mono text-[12.5px] text-[var(--color-ink-2)] hover:bg-[var(--color-row)]",
  today: "[&>button]:font-bold [&>button]:text-[var(--color-accent-strong)]",
  selected: "[&>button]:bg-[var(--color-accent)] [&>button]:text-[var(--color-on-accent)] [&>button]:hover:bg-[var(--color-accent-strong)]",
  outside: "[&>button]:text-[var(--color-faint)]",
  disabled: "[&>button]:text-[var(--color-faint)] [&>button]:pointer-events-none",
  hidden: "invisible",
};

/**
 * Day-level date picker matching the app's own design tokens instead of
 * the browser's native <input type="date"> chrome (which also varies a
 * lot between browsers). Drop-in replacement for a native date input
 * inside a plain <form>/Server Action: it keeps posting the same
 * name="..." value ("YYYY-MM-DD") via a hidden input, so no action code
 * needs to change.
 */
export function DatePicker({
  id,
  name,
  defaultValue,
  required,
  placeholder = "Elegir fecha",
  className = "",
}: {
  id?: string;
  name: string;
  defaultValue?: string;
  required?: boolean;
  placeholder?: string;
  className?: string;
}) {
  const [value, setValue] = useState(defaultValue ?? "");
  const [open, setOpen] = useState(false);
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

  const selected = parseDateValue(value);

  return (
    <div ref={containerRef} className="relative">
      <input type="hidden" id={id} name={name} value={value} required={required} />
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={
          className ||
          "w-full rounded-lg border border-[var(--color-hairline)] bg-[var(--color-surface)] px-3 py-[9px] text-left text-[13.5px] outline-none focus:border-[var(--color-ink)]"
        }
      >
        {value ? (
          <span className="text-[var(--color-ink)]">{formatDisplay(value)}</span>
        ) : (
          <span className="text-[var(--color-faint)]">{placeholder}</span>
        )}
      </button>
      {open ? (
        <div className="absolute left-0 top-[calc(100%+4px)] z-20 rounded-[10px] border border-[var(--color-hairline)] bg-[var(--color-surface)] p-2 shadow-lg">
          <DayPicker
            mode="single"
            locale={es}
            selected={selected}
            defaultMonth={selected}
            onSelect={(date) => {
              setValue(date ? formatDateValue(date) : "");
              setOpen(false);
            }}
            weekStartsOn={1}
            classNames={calendarClassNames}
          />
        </div>
      ) : null}
    </div>
  );
}
