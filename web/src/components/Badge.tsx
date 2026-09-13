const VARIANT_CLASSES = {
  neutral: "bg-[var(--color-row)] text-[var(--color-ink-2)]",
  positive: "bg-[var(--color-accent-soft)] text-[var(--color-accent-strong)]",
  negative: "bg-[var(--color-negative-soft)] text-[var(--color-negative-ink)]",
  warning: "bg-[var(--color-warning-soft)] text-[var(--color-warning-ink)]",
  outline: "border border-[var(--color-hairline)] text-[var(--color-ink-2)]",
} as const;

export type BadgeVariant = keyof typeof VARIANT_CLASSES;

export function Badge({
  children,
  variant = "neutral",
  className = "",
}: {
  children: React.ReactNode;
  variant?: BadgeVariant;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 font-mono text-[11.5px] font-medium uppercase tracking-wide ${VARIANT_CLASSES[variant]} ${className}`}
    >
      {children}
    </span>
  );
}
