"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/Button";
import { confirmSuggestedAllocations, suggestAllAllocations } from "./actions";

/** "Buscar sugerencias" for the month on screen (null = every month). */
export function SuggestAllButton({ companyId, month }: { companyId: string; month: string | null }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  return (
    <span className="flex items-center gap-2">
      <Button
        type="button"
        variant="secondary"
        pending={pending}
        pendingLabel="Buscando…"
        onClick={() =>
          startTransition(async () => {
            const result = await suggestAllAllocations(companyId, month);
            setMessage(
              result.error ??
                (result.created > 0
                  ? `${result.created} ${result.created === 1 ? "factura con sugerencia nueva" : "facturas con sugerencias nuevas"}.`
                  : "No se encontró un destino probable para ninguna factura nueva."),
            );
            router.refresh();
          })
        }
      >
        Buscar sugerencias
      </Button>
      {message ? (
        <span role="status" className="text-[12px] text-[var(--color-muted)]">
          {message}
        </span>
      ) : null}
    </span>
  );
}

/** Confirms the suggestions of one document (or several) as they are. */
export function ConfirmSuggestedButton({
  companyId,
  salesDocumentIds,
  label = "Confirmar",
}: {
  companyId: string;
  salesDocumentIds: string[];
  label?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <span className="inline-flex items-center gap-1.5">
      <button
        type="button"
        disabled={pending || salesDocumentIds.length === 0}
        onClick={() =>
          startTransition(async () => {
            const result = await confirmSuggestedAllocations(companyId, salesDocumentIds);
            setError(result.error);
            router.refresh();
          })
        }
        className="text-[12.5px] font-medium text-[var(--color-accent-strong)] disabled:opacity-60"
      >
        {pending ? "Confirmando…" : label}
      </button>
      {error ? (
        <span role="alert" className="text-[11.5px] text-[var(--color-negative-ink)]">
          {error}
        </span>
      ) : null}
    </span>
  );
}
