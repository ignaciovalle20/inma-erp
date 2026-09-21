"use client";

import { useActionState } from "react";
import { deleteTechnicianCharge, type ChargeActionState } from "./actions";
import { Button } from "@/components/Button";

const initialState: ChargeActionState = { error: null };

/** Deletes a charge loaded by mistake, together with the cost it created. Asks first. */
export function DeleteChargeForm({
  companyId,
  projectId,
  chargeId,
}: {
  companyId: string;
  projectId: string;
  chargeId: string;
}) {
  const [state, formAction, pending] = useActionState(
    deleteTechnicianCharge.bind(null, companyId, projectId, chargeId),
    initialState,
  );

  return (
    <form
      action={formAction}
      onSubmit={(event) => {
        if (!window.confirm("¿Eliminar este cargo? También se elimina el costo que generó en el trabajo.")) {
          event.preventDefault();
        }
      }}
      className="flex flex-col gap-2"
    >
      <Button type="submit" variant="secondary" pending={pending} pendingLabel="Eliminando…">
        Eliminar cargo
      </Button>
      {state.error ? (
        <p className="text-[13px] text-[var(--color-negative-ink)]" role="alert">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
