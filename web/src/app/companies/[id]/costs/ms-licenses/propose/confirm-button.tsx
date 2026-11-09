"use client";

import { useActionState } from "react";
import { confirmMsLicensePool, type ConfirmProposalState } from "./actions";

/** "Confirmar reparto": saves the split the page shows (one month). */
export function ConfirmProposalButton({ companyId, period }: { companyId: string; period: string }) {
  const [state, action, pending] = useActionState<ConfirmProposalState>(
    confirmMsLicensePool.bind(null, companyId, period),
    { error: null },
  );

  return (
    <form action={action} className="flex flex-col items-start gap-1.5">
      <button
        type="submit"
        disabled={pending}
        className="rounded-lg bg-[var(--color-ink)] px-4 py-2 text-[13px] font-medium text-[var(--color-on-ink)] hover:bg-[var(--color-primary-hover)] disabled:opacity-60"
      >
        {pending ? "Repartiendo…" : "Confirmar reparto"}
      </button>
      {state.error ? (
        <p role="alert" className="text-[12.5px] text-[var(--color-negative-ink)]">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
