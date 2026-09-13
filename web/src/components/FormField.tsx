import Link from "next/link";
import { Button } from "@/components/Button";

export const fieldLabel =
  "font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--color-muted)]";
export const fieldInput =
  "rounded-lg border border-[var(--color-hairline)] bg-white px-3 py-[9px] text-[13.5px] text-[var(--color-ink)] outline-none focus:border-[var(--color-ink)] disabled:bg-[var(--color-canvas)] disabled:text-[var(--color-muted)]";

export function Field({
  label,
  htmlFor,
  children,
  hint,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className={fieldLabel}>
        {label}
      </label>
      {children}
      {hint ? <p className="text-[11.5px] text-[var(--color-muted)]">{hint}</p> : null}
    </div>
  );
}

export function FormActions({
  cancelHref,
  pending,
  pendingLabel,
  children,
}: {
  cancelHref: string;
  pending: boolean;
  pendingLabel?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-1 flex items-center gap-3">
      <Button type="submit" pending={pending} pendingLabel={pendingLabel} className="flex-1">
        {children}
      </Button>
      <Link
        href={cancelHref}
        className="text-[13px] text-[var(--color-muted)] hover:text-[var(--color-ink)]"
      >
        Cancelar
      </Link>
    </div>
  );
}
