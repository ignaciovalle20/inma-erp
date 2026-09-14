export default function CompanySectionLoading() {
  return (
    <div className="flex flex-col gap-[18px]">
      <div className="flex flex-col gap-2">
        <div className="h-2.5 w-32 animate-pulse rounded bg-[var(--color-hairline-soft)]" />
        <div className="h-5 w-56 animate-pulse rounded bg-[var(--color-hairline-soft)]" />
      </div>
      <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="h-[92px] animate-pulse rounded-[10px] border border-[var(--color-hairline)] bg-white"
          />
        ))}
      </div>
      <div className="h-64 animate-pulse rounded-[10px] border border-[var(--color-hairline)] bg-white" />
      <div className="h-48 animate-pulse rounded-[10px] border border-[var(--color-hairline)] bg-white" />
    </div>
  );
}
