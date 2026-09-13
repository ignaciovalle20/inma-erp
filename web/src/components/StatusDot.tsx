const COLOR = {
  active: "#2a9c7e",
  inactive: "#c9cdc6",
  negative: "#a8382a",
  warning: "#b08900",
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
