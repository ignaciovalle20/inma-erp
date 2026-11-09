"use client";

import { useActionState } from "react";
import { confirmMsLicenseInvoice, type ConfirmProposalState } from "./actions";

/**
 * "Confirmar reparto": saves the split the page shows (one invoice). When the
 * supplier already has a licenses invoice split in that month, the box
 * "también es de licencias" must be ticked first (a re-billing, for example).
 */
export function ConfirmProposalButton({
  companyId,
  costDocumentId,
  secondInvoice,
}: {
  companyId: string;
  costDocumentId: string;
  /** Another licenses invoice of the same supplier and month is already split. */
  secondInvoice: boolean;
}) {
  const [state, action, pending] = useActionState<ConfirmProposalState, FormData>(
    confirmMsLicenseInvoice.bind(null, companyId, costDocumentId),
    { error: null, needsSecondConfirmation: false },
  );
  const askSecond = secondInvoice || state.needsSecondConfirmation;

  return (
    <form action={action} className="flex flex-col items-start gap-2">
      {askSecond ? (
        <label className="flex items-start gap-2 text-[12.5px] text-[var(--color-ink-2)]">
          <input type="checkbox" name="allow_second" required className="mt-0.5" />
          <span>
            Confirmo que esta también es una factura de licencias MS de ese mes (por ejemplo, una refacturación): su
            neto se reparte aparte, además del reparto que ya tiene el mes.
          </span>
        </label>
      ) : null}
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
