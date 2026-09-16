"use client";

import { useFormStatus } from "react-dom";

/**
 * A text-styled submit button that shows its own pending state via
 * useFormStatus -- for plain <form action={serverAction}> lists (no
 * useActionState) where a bare <button type="submit"> gives zero
 * feedback while the round trip + revalidation runs, making a fast
 * action feel stuck. Must be rendered inside the <form> it submits.
 */
export function SubmitTextButton({
  children,
  pendingLabel,
  className = "",
}: {
  children: React.ReactNode;
  pendingLabel: string;
  className?: string;
}) {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      disabled={pending}
      className={`cursor-pointer disabled:cursor-default disabled:opacity-60 ${className}`}
    >
      {pending ? pendingLabel : children}
    </button>
  );
}
