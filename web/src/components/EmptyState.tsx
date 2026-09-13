export function EmptyState({
  message,
  action,
}: {
  message: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 p-8 text-center">
      <p className="text-[13px] text-[var(--color-muted)]">{message}</p>
      {action}
    </div>
  );
}
