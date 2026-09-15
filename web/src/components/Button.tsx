import Link from "next/link";
import type { ButtonHTMLAttributes } from "react";

const VARIANT_CLASSES = {
  primary:
    "bg-[var(--color-ink)] text-[#f2f2ef] hover:bg-[#24272d] px-4 py-2 rounded-lg",
  secondary:
    "bg-white text-[var(--color-ink)] border border-[var(--color-hairline)] hover:border-[#d5d5d0] px-3.5 py-[7px] rounded-lg",
  ghost: "text-[var(--color-accent-strong)] hover:text-[#0e3f34]",
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
      className={`text-[13px] font-medium disabled:opacity-60 ${VARIANT_CLASSES[variant]} ${className}`}
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
      className={`inline-flex items-center text-[13px] font-medium no-underline ${VARIANT_CLASSES[variant]} ${className}`}
    >
      {children}
    </Link>
  );
}
