"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/Button";
import {
  confirmSuggestedAllocations,
  resolveCostSuggestions,
  resolveTechnicianSuggestions,
  suggestAllAllocations,
} from "./actions";

/** Confirms or discards the suggested service allocations of some purchase invoices. */
export function CostSuggestionButtons({
  companyId,
  costDocumentIds,
  confirmLabel = "Confirmar",
  showDiscard = true,
}: {
  companyId: string;
  costDocumentIds: string[];
  confirmLabel?: string;
  showDiscard?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function run(decision: "confirm" | "discard") {
    startTransition(async () => {
      const result = await resolveCostSuggestions(companyId, costDocumentIds, decision);
      setError(result.error);
      router.refresh();
    });
  }

  return (
    <span className="inline-flex flex-wrap items-center justify-end gap-3">
      <button
        type="button"
        disabled={pending || costDocumentIds.length === 0}
        onClick={() => run("confirm")}
        className="text-[12.5px] font-medium text-[var(--color-accent-strong)] disabled:opacity-60"
      >
        {pending ? "Guardando…" : confirmLabel}
      </button>
      {showDiscard ? (
        <button
          type="button"
          disabled={pending}
          onClick={() => run("discard")}
          className="text-[12.5px] font-medium text-[var(--color-muted)] hover:text-[var(--color-negative-ink)] disabled:opacity-60"
        >
          Descartar
        </button>
      ) : null}
      {error ? (
        <span role="alert" className="text-[11.5px] text-[var(--color-negative-ink)]">
          {error}
        </span>
      ) : null}
    </span>
  );
}

/**
 * Confirms (links) or discards suggested technician documents. A document
 * already assigned somewhere asks first: the link replaces that assignment.
 */
export function TechnicianSuggestionButtons({
  companyId,
  costDocumentIds,
  replacing,
  confirmLabel = "Confirmar",
  showDiscard = true,
}: {
  companyId: string;
  costDocumentIds: string[];
  /** How many of these documents are already assigned (to a job, split or to services). */
  replacing: number;
  confirmLabel?: string;
  showDiscard?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function run(decision: "confirm" | "discard") {
    if (
      decision === "confirm" &&
      replacing > 0 &&
      !window.confirm(
        replacing === 1 && costDocumentIds.length === 1
          ? "Este documento ya está asignado. Al vincularlo a los cargos, esa asignación se reemplaza por la de los cargos. ¿Seguir?"
          : `${replacing} de estos documentos ya están asignados: al vincularlos, esa asignación se reemplaza por la de los cargos. ¿Seguir?`,
      )
    ) {
      return;
    }
    startTransition(async () => {
      const result = await resolveTechnicianSuggestions(companyId, costDocumentIds, decision, replacing > 0);
      setError(result.error);
      router.refresh();
    });
  }

  return (
    <span className="inline-flex flex-wrap items-center justify-end gap-3">
      <button
        type="button"
        disabled={pending || costDocumentIds.length === 0}
        onClick={() => run("confirm")}
        className="text-[12.5px] font-medium text-[var(--color-accent-strong)] disabled:opacity-60"
      >
        {pending ? "Guardando…" : confirmLabel}
      </button>
      {showDiscard ? (
        <button
          type="button"
          disabled={pending}
          onClick={() => run("discard")}
          className="text-[12.5px] font-medium text-[var(--color-muted)] hover:text-[var(--color-negative-ink)] disabled:opacity-60"
        >
          Descartar
        </button>
      ) : null}
      {error ? (
        <span role="alert" className="text-[11.5px] text-[var(--color-negative-ink)]">
          {error}
        </span>
      ) : null}
    </span>
  );
}

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
