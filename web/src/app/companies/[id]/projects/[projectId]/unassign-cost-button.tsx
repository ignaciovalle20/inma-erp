"use client";

import Link from "next/link";
import { useRef, useState, useTransition } from "react";
import { formatAmount } from "@/components/Money";
import { unassignCostFromProject } from "./unassign-cost-actions";

/**
 * "Quitar del trabajo" on an expense of a job's list: asks first in a dialog
 * and only removes the relation with this job. Deleting a document is a
 * separate, explicit action on its own page and in Costos. A technician's
 * charge (Mano de obra) is not removed from here: the dialog links to
 * "Corregir" in the job's Técnicos section.
 */
export function UnassignCostButton({
  companyId,
  projectId,
  costDocumentId,
  summary,
  amount,
  currency,
  isAllocatedShare,
  technicianChargeHref = null,
}: {
  companyId: string;
  projectId: string;
  costDocumentId: string;
  /** "Descripción · Proveedor · fecha" (lib/costDocumentDeletion.ts). */
  summary: string;
  /** What this job carries of the document. */
  amount: number;
  currency: string;
  /** A general cost split across jobs: only this job's part leaves. */
  isAllocatedShare: boolean;
  /** The charge's page when the expense comes from a technician's charge. */
  technicianChargeHref?: string | null;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [chargeHref, setChargeHref] = useState<string | null>(technicianChargeHref);

  function close() {
    dialog.current?.close();
    setError(null);
  }

  return (
    <>
      <button
        type="button"
        onClick={() => dialog.current?.showModal()}
        className="text-[12.5px] font-medium text-[var(--color-negative-ink)] hover:underline"
      >
        Quitar del trabajo
      </button>
      <dialog
        ref={dialog}
        aria-label="Quitar gasto del trabajo"
        onCancel={() => setError(null)}
        className="m-auto w-[min(440px,calc(100vw-32px))] rounded-[10px] border border-[var(--color-hairline)] bg-[var(--color-surface)] p-0 text-left text-[var(--color-ink)] backdrop:bg-black/40"
      >
        <div role="alertdialog" aria-label="Confirmar" className="flex flex-col gap-3 p-4">
          <h2 className="text-[14px] font-semibold">Quitar gasto del trabajo</h2>
          <div className="flex flex-col gap-0.5 rounded-lg bg-[var(--color-surface-muted)] px-3 py-2 text-[12.5px]">
            <span className="whitespace-normal text-[var(--color-ink-2)]">{summary}</span>
            <span className="font-mono font-semibold tabular-nums">
              {formatAmount(amount, currency)} {currency}
            </span>
          </div>

          {chargeHref ? (
            <>
              <p className="whitespace-normal text-[12.5px] text-[var(--color-ink-2)]">
                Este gasto es el cargo de un técnico (Mano de obra). Para no descuadrar sus pagos, no se quita desde
                acá: corregilo o eliminalo desde la sección Técnicos del trabajo.
              </p>
              <div className="flex flex-wrap gap-2">
                <Link
                  href={chargeHref}
                  className="inline-flex min-h-9 items-center rounded-lg bg-[var(--color-ink)] px-3 text-[13px] font-medium text-[var(--color-on-ink)] no-underline"
                >
                  Ir a Corregir cargo
                </Link>
                <button
                  type="button"
                  onClick={close}
                  className="min-h-9 rounded-lg border border-[var(--color-hairline)] bg-[var(--color-surface)] px-3 text-[13px] text-[var(--color-ink)]"
                >
                  Cerrar
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="whitespace-normal text-[12.5px] text-[var(--color-ink-2)]">
                {isAllocatedShare
                  ? "Se quita solo la parte de este trabajo. El documento sigue en Costos, con el resto de su reparto, y esta parte queda sin asignar."
                  : "El documento no se borra: sigue en Costos, sin asignar, con sus líneas y comprobantes, listo para asignarlo a otro trabajo."}
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={isPending}
                  onClick={() =>
                    startTransition(async () => {
                      setError(null);
                      const result = await unassignCostFromProject(companyId, projectId, costDocumentId);
                      if (result?.technicianChargeHref) setChargeHref(result.technicianChargeHref);
                      else if (result?.error) setError(result.error);
                      else dialog.current?.close();
                    })
                  }
                  className="min-h-9 rounded-lg bg-[var(--color-negative-ink)] px-3 text-[13px] font-medium text-[var(--color-on-ink)] disabled:opacity-60"
                >
                  {isPending ? "Quitando…" : "Sí, quitar"}
                </button>
                <button
                  type="button"
                  disabled={isPending}
                  onClick={close}
                  className="min-h-9 rounded-lg border border-[var(--color-hairline)] bg-[var(--color-surface)] px-3 text-[13px] text-[var(--color-ink)]"
                >
                  Cancelar
                </button>
              </div>
            </>
          )}

          {error ? (
            <p role="alert" className="whitespace-normal text-[12.5px] text-[var(--color-negative-ink)]">
              {error}
            </p>
          ) : null}
        </div>
      </dialog>
    </>
  );
}
