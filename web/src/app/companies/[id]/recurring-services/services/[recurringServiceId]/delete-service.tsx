"use client";

import { useState, useTransition } from "react";
import type { DeletionBlockerGroup } from "@/lib/recurringServiceDeletion";
import { deleteRecurringService } from "./delete-actions";

/**
 * "Eliminar servicio", at the end of the service's page: only enabled when
 * no invoice (sale or purchase) is assigned to it -- otherwise it lists
 * which ones to remove first. Asks before deleting.
 */
export function DeleteServiceSection({
  companyId,
  serviceId,
  confirmText,
  groups,
  failed,
}: {
  companyId: string;
  serviceId: string;
  confirmText: string;
  groups: DeletionBlockerGroup[];
  /** The checks could not be read: stay off rather than guess. */
  failed: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const blocked = failed || groups.length > 0;

  return (
    <section className="flex flex-col gap-2 rounded-[10px] border border-[var(--color-hairline)] bg-[var(--color-surface)] p-4">
      <h2 className="text-[12.5px] font-semibold uppercase tracking-[0.08em] text-[var(--color-muted)]">Eliminar servicio</h2>
      {failed ? (
        <p className="text-[12.5px] text-[var(--color-warning-ink)]">
          No se pudo comprobar si el servicio tiene facturas asignadas. Recargá la página.
        </p>
      ) : groups.length > 0 ? (
        <div className="flex flex-col gap-2 text-[12.5px] text-[var(--color-ink-2)]">
          <p>No se puede eliminar mientras tenga facturas asignadas. Quitá primero:</p>
          {groups.map((group) => (
            <div key={group.kind} className="flex flex-col gap-0.5">
              <p className="font-medium text-[var(--color-ink)]">{group.title}</p>
              <ul className="list-disc pl-5">
                {group.items.map((item, index) => (
                  <li key={index}>{item}</li>
                ))}
              </ul>
              <p className="text-[11.5px] text-[var(--color-muted)]">{group.howTo}</p>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-[12.5px] text-[var(--color-ink-2)]">
          Borra el servicio con todo su historial de ciclos y sus períodos de costo. Las facturas no se tocan.
        </p>
      )}

      {confirming ? (
        <div role="alertdialog" aria-label="Confirmar eliminación" className="flex flex-col gap-2 rounded-lg bg-[var(--color-negative-soft)] p-3">
          <p className="text-[12.5px] text-[var(--color-negative-ink)]">{confirmText}</p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={isPending}
              onClick={() =>
                startTransition(async () => {
                  setError(null);
                  const result = await deleteRecurringService(companyId, serviceId);
                  if (result?.error) setError(result.error);
                })
              }
              className="min-h-9 rounded-lg bg-[var(--color-negative-ink)] px-3 text-[13px] font-medium text-[var(--color-on-ink)] disabled:opacity-60"
            >
              {isPending ? "Eliminando…" : "Sí, eliminar"}
            </button>
            <button
              type="button"
              disabled={isPending}
              onClick={() => setConfirming(false)}
              className="min-h-9 rounded-lg border border-[var(--color-hairline)] bg-[var(--color-surface)] px-3 text-[13px] text-[var(--color-ink)]"
            >
              Cancelar
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          disabled={blocked}
          onClick={() => setConfirming(true)}
          className="w-fit min-h-9 rounded-lg border border-[var(--color-negative-ink)] bg-[var(--color-surface)] px-3 text-[13px] font-medium text-[var(--color-negative-ink)] disabled:cursor-not-allowed disabled:border-[var(--color-hairline)] disabled:text-[var(--color-muted)]"
        >
          Eliminar servicio
        </button>
      )}

      {error ? (
        <p role="alert" className="text-[12.5px] text-[var(--color-negative-ink)]">
          {error}
        </p>
      ) : null}
    </section>
  );
}
