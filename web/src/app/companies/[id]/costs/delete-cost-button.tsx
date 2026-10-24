"use client";

import Link from "next/link";
import { useRef, useState, useTransition } from "react";
import { formatAmount } from "@/components/Money";
import { deleteCostDocument } from "./[costDocumentId]/delete-actions";

/**
 * "Eliminar" on an expense, in a row of a list or on the document's page:
 * asks first in a dialog that names the expense and its amount. A
 * technician's charge (Mano de obra) is not deleted from here: the dialog
 * says so and links to "Corregir" in the job's Técnicos section, where
 * deleting it keeps the technician's payments in step.
 */
export function DeleteCostButton({
  companyId,
  costDocumentId,
  summary,
  amount,
  currency,
  note = null,
  technicianChargeHref = null,
  redirectTo = null,
  variant = "link",
}: {
  companyId: string;
  costDocumentId: string;
  /** "Descripción · Proveedor · fecha" (lib/costDocumentDeletion.ts). */
  summary: string;
  /** The document's total, which is what gets deleted. */
  amount: number;
  currency: string;
  note?: string | null;
  /** The charge's page when the expense comes from a technician's charge. */
  technicianChargeHref?: string | null;
  /** Where to go after deleting (the document's own page); lists stay put. */
  redirectTo?: string | null;
  variant?: "link" | "button";
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
        className={
          variant === "button"
            ? "inline-flex min-h-9 w-fit items-center rounded-lg border border-[var(--color-negative-ink)] bg-[var(--color-surface)] px-3 text-[13px] font-medium text-[var(--color-negative-ink)]"
            : "text-[12.5px] font-medium text-[var(--color-negative-ink)] hover:underline"
        }
      >
        Eliminar
      </button>
      <dialog
        ref={dialog}
        aria-label="Eliminar gasto"
        onCancel={() => setError(null)}
        className="m-auto w-[min(440px,calc(100vw-32px))] rounded-[10px] border border-[var(--color-hairline)] bg-[var(--color-surface)] p-0 text-left text-[var(--color-ink)] backdrop:bg-black/40"
      >
        <div role="alertdialog" aria-label="Confirmar eliminación" className="flex flex-col gap-3 p-4">
          <h2 className="text-[14px] font-semibold">Eliminar gasto</h2>
          <div className="flex flex-col gap-0.5 rounded-lg bg-[var(--color-surface-muted)] px-3 py-2 text-[12.5px]">
            <span className="whitespace-normal text-[var(--color-ink-2)]">{summary}</span>
            <span className="font-mono font-semibold tabular-nums">
              {formatAmount(amount, currency)} {currency}
            </span>
          </div>

          {chargeHref ? (
            <>
              <p className="whitespace-normal text-[12.5px] text-[var(--color-ink-2)]">
                Este gasto es el cargo de un técnico (Mano de obra). Para no descuadrar sus pagos, no se elimina desde
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
              <p className="whitespace-normal text-[12.5px] text-[var(--color-negative-ink)]">
                ¿Eliminar este gasto? Se borran también sus líneas, sus asignaciones a trabajos y a servicios, y sus
                comprobantes adjuntos. No se puede deshacer.
              </p>
              {note ? <p className="whitespace-normal text-[12px] text-[var(--color-muted)]">{note}</p> : null}
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={isPending}
                  onClick={() =>
                    startTransition(async () => {
                      setError(null);
                      const result = await deleteCostDocument(companyId, costDocumentId, redirectTo);
                      if (result?.technicianChargeHref) setChargeHref(result.technicianChargeHref);
                      else if (result?.error) setError(result.error);
                      else dialog.current?.close();
                    })
                  }
                  className="min-h-9 rounded-lg bg-[var(--color-negative-ink)] px-3 text-[13px] font-medium text-[var(--color-on-ink)] disabled:opacity-60"
                >
                  {isPending ? "Eliminando…" : "Sí, eliminar"}
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
