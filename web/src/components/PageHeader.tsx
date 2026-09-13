export function PageHeader({
  eyebrow,
  title,
  subtitle,
  actions,
}: {
  eyebrow?: string;
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex flex-col gap-1">
        {eyebrow ? (
          <div className="font-mono text-[10px] font-normal uppercase tracking-[0.14em] text-[var(--color-muted)]">
            {eyebrow}
          </div>
        ) : null}
        <h1 className="text-[16px] font-semibold tracking-[-0.01em] text-[var(--color-ink)]">
          {title}
        </h1>
        {subtitle ? (
          <p className="text-[12.5px] text-[var(--color-muted)]">{subtitle}</p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      ) : null}
    </div>
  );
}
