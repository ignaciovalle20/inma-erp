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
      className={`surface-card min-w-0 ${className}`}
      style={{ padding }}
    >
      {children}
    </div>
  );
}
