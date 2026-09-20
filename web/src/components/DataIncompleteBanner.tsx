/**
 * Shown whenever a report's underlying queries hit a Supabase error --
 * previously such a failure silently became 0/empty in the aggregate
 * (network hiccup, RLS mismatch, timeout), so the figures below could
 * look like a normal, complete result while actually missing whatever
 * that failed query would have contributed. This never guesses at what
 * is missing; it only says the total may be understated, and -- when the
 * report says which queries failed -- lists them, so the real cause is on
 * screen and not only in the server log.
 */
export function DataIncompleteBanner({ details = [] }: { details?: string[] }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-3 rounded-[10px] border border-[var(--color-negative)] bg-[var(--color-negative-soft)] px-4 py-3"
    >
      <span className="mt-1.5 h-2 w-2 flex-none rounded-full bg-[var(--color-negative)]" />
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
        {details.length > 0 ? (
          <ul className="mt-1 list-disc pl-4 text-[12px] text-[var(--color-negative-ink)]">
            {details.map((detail) => (
              <li key={detail}>No se pudo leer {detail}</li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
