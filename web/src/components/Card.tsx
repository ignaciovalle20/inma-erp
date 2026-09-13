export function Card({
  children,
  className = "",
  padding = "16px 16px 14px",
}: {
  children: React.ReactNode;
  className?: string;
  padding?: string;
}) {
  return (
    <div
      className={`rounded-[10px] border border-[var(--color-hairline)] bg-[var(--color-surface)] ${className}`}
      style={{ padding }}
    >
      {children}
    </div>
  );
}
