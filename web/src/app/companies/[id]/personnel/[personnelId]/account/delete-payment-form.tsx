"use client";

import { useActionState } from "react";
import { deleteTechnicianPayment, type PaymentActionState } from "./actions";

const initialState: PaymentActionState = { error: null };

/** Deletes a payment recorded by mistake; the charges it covered owe that money again. Asks first. */
export function DeletePaymentForm({
  companyId,
  personnelId,
  paymentId,
}: {
  companyId: string;
  personnelId: string;
  paymentId: string;
}) {
  const [state, formAction, pending] = useActionState(
    deleteTechnicianPayment.bind(null, companyId, personnelId, paymentId),
    initialState,
  );

  return (
    <form
      action={formAction}
      onSubmit={(event) => {
        if (!window.confirm("¿Eliminar este pago? Los cargos que cubría vuelven a quedar pendientes de pago.")) {
          event.preventDefault();
        }
      }}
      className="flex flex-col items-end gap-1"
    >
      <button
        type="submit"
        disabled={pending}
        className="cursor-pointer text-[12.5px] font-medium text-[var(--color-negative-ink)] disabled:cursor-default disabled:opacity-60"
      >
        {pending ? "Eliminando…" : "Eliminar"}
      </button>
      {state.error ? (
        <span className="max-w-[220px] text-right text-[11.5px] text-[var(--color-negative-ink)]" role="alert">
          {state.error}
        </span>
      ) : null}
    </form>
  );
}
