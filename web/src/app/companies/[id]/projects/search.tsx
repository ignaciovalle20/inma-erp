"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { initialSearchSync, searchQueryChanged, searchSent } from "@/lib/searchSync";

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
  const sync = useRef(initialSearchSync(query));
  // `keep` is a new object on every render of the page; its content is
  // what matters (an RSC refresh must not restart the debounce).
  const keepKey = JSON.stringify(keep);

  // The URL can change from outside (a tab link clears q, back/forward):
  // follow it. Echoes of what this box sent -- including an older search
  // landing after the user typed more -- never overwrite the box
  // (lib/searchSync).
  useEffect(() => {
    const result = searchQueryChanged(sync.current, query);
    sync.current = result.state;
    if (result.adopt !== null) setValue(result.adopt);
  }, [query]);

  useEffect(() => {
    const next = value.trim();
    if (next === sync.current.lastSent) return;

    const timer = setTimeout(() => {
      sync.current = searchSent(sync.current, next);
      const params = new URLSearchParams(JSON.parse(keepKey) as Record<string, string>);
      if (next) params.set("q", next);
      const qs = params.toString();
      startTransition(() => {
        router.replace(qs ? `${basePath}?${qs}` : basePath, { scroll: false });
      });
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [value, keepKey, basePath, router]);

  return (
    <div className="relative w-full max-w-[420px]">
      <input
        type="search"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder="Buscar por proyecto, cliente, alias, N° de cotización o factura"
        aria-label="Buscar proyectos"
        className="control-sm w-full"
      />
      {isPending ? (
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[11px] text-[var(--color-faint)]">
          Buscando…
        </span>
      ) : null}
    </div>
  );
}
