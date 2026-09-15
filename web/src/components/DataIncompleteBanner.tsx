/**
 * Shown whenever a report's underlying queries hit a Supabase error --
 * previously such a failure silently became 0/empty in the aggregate
 * (network hiccup, RLS mismatch, timeout), so the figures below could
 * look like a normal, complete result while actually missing whatever
 * that failed query would have contributed. This never guesses at what
 * is missing; it only says the total may be understated.
 */
export function DataIncompleteBanner() {
  return (
    <div
      role="alert"
      className="flex items-center gap-3 rounded-[10px] border border-[var(--color-negative)] bg-[var(--color-negative-soft)] px-4 py-3"
    >
      <span className="h-2 w-2 flex-none rounded-full bg-[var(--color-negative)]" />
      <div className="flex flex-col gap-0.5">
        <span className="text-[13px] font-semibold text-[var(--color-negative-ink)]">
          Datos incompletos
        </span>
        <span className="text-[12.5px] text-[var(--color-negative-ink)]">
          Una consulta falló al calcular este reporte -- las cifras
          mostradas pueden estar subestimadas. Recargá la página; si
          persiste, contactá a soporte antes de tomar decisiones sobre
          este resultado.
        </span>
      </div>
    </div>
  );
}
