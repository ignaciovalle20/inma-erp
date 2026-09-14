"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { fieldInput } from "@/components/FormField";
import {
  reassignCostDocumentPeriod,
  type ReassignPeriodState,
} from "./actions";

/** Formats a "YYYY-MM-01" period date as "septiembre de 2026". */
export function formatPeriod(period: string): string {
  const date = new Date(`${period}T00:00:00Z`);
  return date.toLocaleDateString("es-ES", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Story 6.6 (§1a redesign): "Reasignar mes" collapses to one status row
 * inside a Card, with the month input/explanation revealed on demand
 * instead of always on screen. Same action, same validation -- see the
 * matching comment on reassign_cost_document_period() for why this is
 * the one write path this otherwise read-only detail page gets.
 */
export function ReassignPeriodForm({
  companyId,
  costDocumentId,
  recognizedPeriod,
  recognizedPeriodSetBy,
  recognizedPeriodSetAt,
  currentUserId,
  currentUserEmail,
}: {
  companyId: string;
  costDocumentId: string;
  recognizedPeriod: string | null;
  recognizedPeriodSetBy: string | null;
  recognizedPeriodSetAt: string | null;
  currentUserId: string | null;
  currentUserEmail: string | null;
}) {
  const reassignWithIds = reassignCostDocumentPeriod.bind(
    null,
    companyId,
    costDocumentId,
  );

  const initialState: ReassignPeriodState = { error: null };
  const [state, formAction, pending] = useActionState(
    reassignWithIds,
    initialState,
  );
  const [expanded, setExpanded] = useState(false);

  const setterLabel =
    recognizedPeriodSetBy && currentUserId === recognizedPeriodSetBy
      ? (currentUserEmail ?? "vos")
      : "otro usuario";

  const statusLabel =
    recognizedPeriod && recognizedPeriodSetAt ? (
      <>
        Reconocido en {formatPeriod(recognizedPeriod)}, reasignado por{" "}
        {setterLabel} el{" "}
        {new Date(recognizedPeriodSetAt).toLocaleDateString("es-ES")}.
      </>
    ) : (
      "No reasignado — reconocido en el mes de la fecha del documento."
    );

  return (
    <Card className="flex flex-col gap-3 bg-[var(--color-surface-muted)]">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[12.5px] text-[var(--color-ink-2)]">{statusLabel}</p>
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="shrink-0 rounded-lg border border-[var(--color-hairline)] bg-white px-3.5 py-[7px] text-[13px] font-medium text-[var(--color-ink)] hover:border-[#d5d5d0]"
        >
          Reasignar mes
        </button>
      </div>

      {expanded ? (
        <form action={formAction} className="flex flex-col gap-2">
          <p className="text-[11.5px] text-[var(--color-muted)]">
            Por defecto, este documento se reconoce en el mes de su fecha en
            todos los reportes. Reasignalo acá si su costo debe reconocerse
            en otro mes (por ejemplo, un proyecto de varios meses) -- esto
            nunca cambia la fecha del documento ni ningún importe.
          </p>
          <div className="flex items-end gap-2">
            <input
              id="recognized_period"
              name="recognized_period"
              type="month"
              required
              aria-label="Reconocer en el mes"
              defaultValue={recognizedPeriod ? recognizedPeriod.slice(0, 7) : ""}
              className={fieldInput}
            />
            <Button
              type="submit"
              variant="secondary"
              pending={pending}
              pendingLabel="Reasignando…"
            >
              Reasignar
            </Button>
          </div>
        </form>
      ) : null}

      {state.error ? (
        <p className="text-[12.5px] text-[var(--color-negative-ink)]" role="alert">
          {state.error}
        </p>
      ) : null}
    </Card>
  );
}
