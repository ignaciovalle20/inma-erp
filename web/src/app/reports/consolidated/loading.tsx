export default function ConsolidatedReportLoading() {
  return (
    <div className="flex min-h-screen flex-1 items-center justify-center bg-[var(--color-canvas)]">
      <div className="flex w-full max-w-3xl flex-col gap-6 px-4">
        <div className="flex flex-col gap-2">
          <div className="h-2.5 w-32 animate-pulse rounded bg-[var(--color-hairline-soft)]" />
          <div className="h-5 w-56 animate-pulse rounded bg-[var(--color-hairline-soft)]" />
        </div>
        {Array.from({ length: 3 }).map((_, i) => (
          <div
            key={i}
            className="h-[86px] animate-pulse rounded-[10px] border border-[var(--color-hairline)] bg-white"
          />
        ))}
      </div>
    </div>
  );
}
