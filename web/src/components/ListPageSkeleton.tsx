/**
 * Shared instant-loading skeleton for list pages (sales, costs,
 * personnel, clients, suppliers, areas, recurring services, projects)
 * -- shape-matched to PageHeader + filter row + TableCard, so the
 * fallback shown during navigation looks like the page it's replacing
 * instead of the company dashboard's KPI-card shape (the nearest
 * ancestor loading.tsx would otherwise show).
 */
export function ListPageSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-[18px]">
      <div className="flex flex-col gap-2">
        <div className="h-2.5 w-32 animate-pulse rounded bg-[var(--color-hairline-soft)]" />
        <div className="h-5 w-56 animate-pulse rounded bg-[var(--color-hairline-soft)]" />
      </div>
      <div className="h-10 w-full animate-pulse rounded-[10px] border border-[var(--color-hairline)] bg-white" />
      <div className="overflow-hidden rounded-[10px] border border-[var(--color-hairline)] bg-white">
        {Array.from({ length: rows }).map((_, i) => (
          <div
            key={i}
            className="h-11 animate-pulse border-b border-[var(--color-hairline-soft)] last:border-b-0"
            style={{ animationDelay: `${i * 40}ms` }}
          />
        ))}
      </div>
    </div>
  );
}
