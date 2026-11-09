"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { undoCostPool } from "./actions";

/**
 * "Deshacer reparto" (fix-ms-invoice 2026-11): deletes the pool and its
 * shares. Its invoice goes back to being a general cost, free to be assigned
 * to its job or split again as the licenses invoice.
 */
export function UndoCostPoolButton({
  companyId,
  costPoolId,
  hasInvoice,
}: {
  companyId: string;
  costPoolId: string;
  /** The pool splits one invoice (else it was typed by hand for its month). */
  hasInvoice: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleClick() {
    const message = hasInvoice
      ? "Se borra este reparto: la factura vuelve a contar como gasto general y los clientes de licencias pierden ese costo. Después podés asignarla a su trabajo o repartir la factura correcta. ¿Seguir?"
      : "Se borra este reparto: las facturas del proveedor de ese mes vuelven a contar como gasto general y los clientes de licencias pierden ese costo. Después podés repartir la factura de licencias del mes. ¿Seguir?";
    if (!window.confirm(message)) return;
    setError(null);
    startTransition(async () => {
      const result = await undoCostPool(companyId, costPoolId);
      if (result.error) {
        setError(result.error);
        return;
      }
      router.push(`/companies/${companyId}/costs/ms-licenses`);
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col items-start gap-1.5">
      <button
        type="button"
        onClick={handleClick}
        disabled={isPending}
        className="rounded-lg border border-[var(--color-negative-soft-border)] px-4 py-2 text-[13px] font-medium text-[var(--color-negative-ink)] hover:bg-[var(--color-negative-soft)] disabled:opacity-60"
      >
        {isPending ? "Deshaciendo…" : "Deshacer reparto"}
      </button>
      {error ? (
        <p role="alert" className="text-[12.5px] text-[var(--color-negative-ink)]">
          {error}
        </p>
      ) : null}
    </div>
  );
}
