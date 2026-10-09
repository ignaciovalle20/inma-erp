import Link from "next/link";
import type { ButtonHTMLAttributes } from "react";

// primary/secondary are 36px tall, like the form controls (globals.css
// @utility control), so a button next to an input lines up.
const VARIANT_CLASSES = {
  primary:
    "inline-flex min-h-9 items-center justify-center whitespace-nowrap rounded-control border border-transparent bg-[var(--color-ink)] px-4 text-[var(--color-on-ink)] hover:bg-[var(--color-primary-hover)] hover:text-[var(--color-on-ink)]",
  secondary:
    "inline-flex min-h-9 items-center justify-center whitespace-nowrap rounded-control border border-[var(--color-hairline)] bg-[var(--color-surface)] px-3.5 text-[var(--color-ink)] hover:border-[var(--color-border-hover)] hover:text-[var(--color-ink)]",
  ghost: "text-[var(--color-accent-strong)] hover:text-[var(--color-link-hover)]",
} as const;

export type ButtonVariant = keyof typeof VARIANT_CLASSES;

type CommonProps = {
  variant?: ButtonVariant;
  pending?: boolean;
  pendingLabel?: string;
  children: React.ReactNode;
  className?: string;
};

export function Button({
  variant = "primary",
  pending = false,
  pendingLabel,
  children,
  className = "",
  ...rest
}: CommonProps & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...rest}
      disabled={pending || rest.disabled}
      className={`text-body font-medium disabled:cursor-not-allowed disabled:opacity-60 ${VARIANT_CLASSES[variant]} ${className}`}
    >
      {pending ? (pendingLabel ?? "Guardando…") : children}
    </button>
  );
}

export function LinkButton({
  href,
  variant = "primary",
  children,
  className = "",
}: {
  href: string;
  variant?: ButtonVariant;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Link
      href={href}
      className={`inline-flex items-center text-body font-medium no-underline ${VARIANT_CLASSES[variant]} ${className}`}
    >
      {children}
    </Link>
  );
}
