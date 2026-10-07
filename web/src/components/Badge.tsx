/**
 * The one semantic color system for status badges: positive (éxito),
 * warning (alerta), negative (peligro), neutral and outline. Every
 * text/background pair is >= 4.5:1 (WCAG AA) in both themes -- the colors
 * are the globals.css tokens.
 */
const VARIANT_CLASSES = {
  neutral: "border-transparent bg-[var(--color-row)] text-[var(--color-ink-2)]",
  positive: "border-[var(--color-accent-soft-border)] bg-[var(--color-accent-soft)] text-[var(--color-accent-strong)]",
  negative: "border-[var(--color-negative-soft-border)] bg-[var(--color-negative-soft)] text-[var(--color-negative-ink)]",
  warning: "border-[var(--color-warning-soft-border)] bg-[var(--color-warning-soft)] text-[var(--color-warning-ink)]",
  outline: "border-[var(--color-hairline)] text-[var(--color-ink-2)]",
} as const;

export type BadgeVariant = keyof typeof VARIANT_CLASSES;

export function Badge({
  children,
  variant = "neutral",
  className = "",
  title,
}: {
  children: React.ReactNode;
  variant?: BadgeVariant;
  className?: string;
  title?: string;
}) {
  // Never wraps a word onto a second line; a badge wider than its container
  // (a very long quote number) ends in an ellipsis instead of spilling out.
  return (
    <span
      title={title}
      className={`inline-flex max-w-full items-center gap-1 whitespace-nowrap rounded-badge border px-2 py-0.5 font-mono text-caption font-medium uppercase tracking-wide ${VARIANT_CLASSES[variant]} ${className}`}
    >
      <span className="min-w-0 truncate">{children}</span>
    </span>
  );
}
