const COLOR = {
  active: "var(--color-accent-bright)",
  inactive: "var(--color-neutral-bar)",
  negative: "var(--color-negative)",
  warning: "var(--color-warning)",
} as const;

export function StatusDot({
  status,
  className = "",
}: {
  status: keyof typeof COLOR;
  className?: string;
}) {
  return (
    <span
      className={`inline-block h-1.5 w-1.5 rounded-full ${className}`}
      style={{ backgroundColor: COLOR[status] }}
    />
  );
}
