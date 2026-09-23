"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { markOccurrenceInvoiced, markOccurrenceCollected, voidOccurrence } from "./actions";
import type { RecurringServiceOccurrenceStatus } from "@/lib/dal";

type Action = (companyId: string, occurrenceId: string) => Promise<{ error: string | null }>;

// Mobile-first, one-tap actions -- the whole point of this screen is
// replacing "flip the Trello card" with "tap this button", per
// plan-servicios-recurrentes.md's UI section. Anular is the one
// irreversible action, so it's secondary and asks first.
export function OccurrenceActions({
  companyId,
  occurrenceId,
  status,
}: {
  companyId: string;
  occurrenceId: string;
  status: RecurringServiceOccurrenceStatus;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [running, setRunning] = useState<"primary" | "void" | null>(null);
  const [error, setError] = useState<string | null>(null);

  function run(kind: "primary" | "void", action: Action) {
    setError(null);
    setRunning(kind);
    startTransition(async () => {
      const result = await action(companyId, occurrenceId);
      setRunning(null);
      if (result.error) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  const primary =
    status === "pending_invoice"
      ? { label: "Marcar Facturado", action: markOccurrenceInvoiced }
      : status === "invoiced"
        ? { label: "Marcar Cobrado", action: markOccurrenceCollected }
        : null;

  return (
    <div className="flex flex-col items-stretch gap-1 md:items-end">
      <div className="flex items-center gap-3">
        {primary ? (
          <button
            type="button"
            onClick={() => run("primary", primary.action)}
            disabled={isPending}
            className="min-h-10 flex-1 rounded-lg bg-[var(--color-ink)] px-3 py-2 text-[13px] font-medium text-[var(--color-on-ink)] hover:bg-[var(--color-primary-hover)] disabled:opacity-60 md:min-h-0 md:flex-none md:py-1.5 md:text-[12.5px]"
          >
            {running === "primary" ? "Marcando…" : primary.label}
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => {
            if (
              window.confirm(
                "¿Anular este pendiente? No se va a volver a generar para este período y no se puede deshacer.",
              )
            ) {
              run("void", voidOccurrence);
            }
          }}
          disabled={isPending}
          className="min-h-10 cursor-pointer px-1 text-[12.5px] font-medium text-[var(--color-negative-ink)] disabled:cursor-default disabled:opacity-60 md:min-h-0"
        >
          {running === "void" ? "Anulando…" : "Anular"}
        </button>
      </div>
      {error ? (
        <p role="alert" className="text-[11.5px] text-[var(--color-negative-ink)] md:max-w-[220px] md:text-right">
          {error}
        </p>
      ) : null}
    </div>
  );
}
