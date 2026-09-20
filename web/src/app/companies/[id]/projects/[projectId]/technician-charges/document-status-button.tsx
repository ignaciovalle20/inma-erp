"use client";

import { useActionState } from "react";
import { Badge } from "@/components/Badge";
import { setTechnicianChargeDocument, type ChargeActionState } from "./actions";
import type { DocumentStatus } from "@/lib/technicians";

const initialState: ChargeActionState = { error: null };

/**
 * The boleta / factura of a charge: pending until it arrives. One click marks
 * it received; a second one undoes it if it was a slip. A failure shows under
 * the button.
 */
export function DocumentStatusButton({
  companyId,
  projectId,
  chargeId,
  status,
  documentName,
}: {
  companyId: string;
  projectId: string;
  chargeId: string;
  status: DocumentStatus;
  documentName: string;
}) {
  const next: DocumentStatus = status === "pendiente" ? "recibida" : "pendiente";
  const [state, formAction, pending] = useActionState(
    setTechnicianChargeDocument.bind(null, companyId, projectId, chargeId, next),
    initialState,
  );

  return (
    <form action={formAction} className="flex flex-col items-start gap-1">
      <Badge variant={status === "recibida" ? "positive" : "warning"}>
        {status === "recibida" ? "Recibida" : "Pendiente"}
      </Badge>
      <button
        type="submit"
        disabled={pending}
        className="cursor-pointer text-[11.5px] font-medium text-[var(--color-accent-strong)] disabled:cursor-default disabled:opacity-60"
      >
        {pending
          ? "Guardando…"
          : status === "pendiente"
            ? `Marcar ${documentName.toLowerCase()} recibida`
            : "Deshacer"}
      </button>
      {state.error ? (
        <span className="text-[11.5px] text-[var(--color-negative-ink)]" role="alert">
          {state.error}
        </span>
      ) : null}
    </form>
  );
}
