import Link from "next/link";
import { Button } from "@/components/Button";

// The looks live in globals.css (@utility field-label / control /
// control-sm) so every form, filter and card control matches.
export const fieldLabel = "field-label";
/** Inputs, selects and textareas of forms (36px). */
export const fieldInput = "control";
/** Compact controls: toolbars, table rows, board cards (32px). */
export const fieldInputSm = "control-sm";

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
      {hint ? <p className="text-small text-muted">{hint}</p> : null}
    </div>
  );
}

export function FormActions({
  cancelHref,
  cancelLabel = "Cancelar",
  pending,
  pendingLabel,
  children,
}: {
  cancelHref: string;
  /** "Cancelar" until something was saved; then the way out is a plain "Volver". */
  cancelLabel?: string;
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
        {cancelLabel}
      </Link>
    </div>
  );
}
