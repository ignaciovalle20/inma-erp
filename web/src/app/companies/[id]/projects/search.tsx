"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

const DEBOUNCE_MS = 300;

/**
 * Search box of the projects list. Writes `?q=` (debounced) and lets the
 * server render the results -- the search itself runs in Postgres
 * (list_projects). `keep` is the rest of the querystring to preserve (tab,
 * period); the page number is always dropped, a new search starts at page 1.
 */
export function ProjectSearch({
  basePath,
  query,
  keep,
}: {
  basePath: string;
  query: string;
  keep: Record<string, string>;
}) {
  const router = useRouter();
  const [value, setValue] = useState(query);
  const [isPending, startTransition] = useTransition();
  const lastSent = useRef(query);

  // The URL can change from outside (a tab link clears q, back/forward):
  // follow it, unless it is just the echo of what this box sent.
  useEffect(() => {
    if (query !== lastSent.current) {
      lastSent.current = query;
      setValue(query);
    }
  }, [query]);

  useEffect(() => {
    const next = value.trim();
    if (next === lastSent.current) return;

    const timer = setTimeout(() => {
      lastSent.current = next;
      const params = new URLSearchParams(keep);
      if (next) params.set("q", next);
      const qs = params.toString();
      startTransition(() => {
        router.replace(qs ? `${basePath}?${qs}` : basePath, { scroll: false });
      });
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [value, keep, basePath, router]);

  return (
    <div className="relative w-full max-w-[420px]">
      <input
        type="search"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder="Buscar por proyecto, cliente, alias, N° de cotización o factura"
        aria-label="Buscar proyectos"
        className="w-full rounded-lg border border-[var(--color-hairline)] bg-[var(--color-surface)] px-3 py-[7px] text-[13px] text-[var(--color-ink)] placeholder:text-[var(--color-faint)]"
      />
      {isPending ? (
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[11px] text-[var(--color-faint)]">
          Buscando…
        </span>
      ) : null}
    </div>
  );
}
