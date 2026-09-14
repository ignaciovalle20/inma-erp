/**
 * Shared instant-loading skeleton for report pages (monthly result,
 * profitability) -- shape-matched to PageHeader + a couple of report
 * cards, so navigation into a report shows something closer to its own
 * layout instead of the company dashboard's KPI-card shape.
 */
export function ReportPageSkeleton() {
  return (
    <div className="flex flex-col gap-[18px]">
      <div className="flex flex-col gap-2">
        <div className="h-2.5 w-32 animate-pulse rounded bg-[var(--color-hairline-soft)]" />
        <div className="h-5 w-56 animate-pulse rounded bg-[var(--color-hairline-soft)]" />
      </div>
      <div className="h-72 animate-pulse rounded-[10px] border border-[var(--color-hairline)] bg-white" />
      <div className="h-56 animate-pulse rounded-[10px] border border-[var(--color-hairline)] bg-white" />
    </div>
  );
}
