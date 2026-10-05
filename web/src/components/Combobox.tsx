"use client";

import { useEffect, useMemo, useRef, useState } from "react";

export type ComboboxOption = { value: string; label: string };

/**
 * Type-to-filter replacement for a plain <select> with many options
 * (clients, projects, suppliers) -- picking one by scrolling a long
 * native dropdown doesn't scale once a company has dozens of them.
 * Posts the same name="..." value via a hidden input, so it drops into
 * an existing <form>/Server Action without any action code changing --
 * same pattern as DatePicker.
 */
export function Combobox({
  id,
  name,
  value,
  onChange,
  options,
  placeholder = "Buscar…",
  emptyLabel = "Sin resultados",
  required,
  disabled,
  className = "",
}: {
  id?: string;
  name: string;
  value: string;
  onChange: (value: string) => void;
  options: ComboboxOption[];
  placeholder?: string;
  emptyLabel?: string;
  required?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const selectedOption = options.find((option) => option.value === value) ?? null;

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        setQuery("");
      }
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return options;
    return options.filter((option) => option.label.toLowerCase().includes(needle));
  }, [options, query]);

  function selectOption(option: ComboboxOption) {
    onChange(option.value);
    setQuery("");
    setOpen(false);
  }

  return (
    <div ref={containerRef} className="relative">
      <input type="hidden" name={name} value={value} required={required} />
      <input
        id={id}
        ref={inputRef}
        type="text"
        disabled={disabled}
        value={open ? query : (selectedOption?.label ?? "")}
        placeholder={selectedOption ? undefined : placeholder}
        onFocus={() => {
          setOpen(true);
          setQuery("");
        }}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            if (filtered.length === 1) selectOption(filtered[0]);
          }
        }}
        className={
          className ||
          "w-full rounded-lg border border-[var(--color-hairline)] bg-[var(--color-surface)] px-3 py-[9px] text-[13.5px] text-[var(--color-ink)] outline-none focus:border-[var(--color-ink)] disabled:bg-[var(--color-canvas)] disabled:text-[var(--color-muted)]"
        }
      />
      {open ? (
        <div className="absolute left-0 top-[calc(100%+4px)] z-20 max-h-64 w-full overflow-auto rounded-[10px] border border-[var(--color-hairline)] bg-[var(--color-surface)] p-1 shadow-lg">
          {value ? (
            <button
              type="button"
              onClick={() => selectOption({ value: "", label: "" })}
              className="block w-full rounded-md px-2.5 py-1.5 text-left text-[12.5px] text-[var(--color-muted)] hover:bg-[var(--color-row)]"
            >
              Limpiar selección
            </button>
          ) : null}
          {filtered.length === 0 ? (
            <p className="px-2.5 py-1.5 text-[12.5px] text-[var(--color-muted)]">{emptyLabel}</p>
          ) : (
            filtered.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => selectOption(option)}
                className={`block w-full rounded-md px-2.5 py-1.5 text-left text-[13px] hover:bg-[var(--color-row)] ${
                  option.value === value
                    ? "text-[var(--color-accent-strong)]"
                    : "text-[var(--color-ink)]"
                }`}
              >
                {option.label}
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
