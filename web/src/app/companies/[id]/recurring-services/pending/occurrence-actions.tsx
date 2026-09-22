"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { markOccurrenceInvoiced, markOccurrenceCollected } from "./actions";
import type { RecurringServiceOccurrenceStatus } from "@/lib/dal";

// Mobile-first, one-tap actions -- the whole point of this screen is
// replacing "flip the Trello card" with "tap this button", per
// plan-servicios-recurrentes.md's UI section.
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
  const [error, setError] = useState<string | null>(null);

  function handleClick(
    action: (companyId: string, occurrenceId: string) => Promise<{ error: string | null }>,
  ) {
    setError(null);
    startTransition(async () => {
      const result = await action(companyId, occurrenceId);
      if (result.error) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  const buttonClass =
    "rounded-lg bg-[var(--color-ink)] px-3 py-1.5 text-[12.5px] font-medium text-[var(--color-on-ink)] hover:bg-[var(--color-primary-hover)] disabled:opacity-60";

  return (
    <div className="flex flex-col items-end gap-1">
      {status === "pending_invoice" ? (
        <button
          type="button"
          onClick={() => handleClick(markOccurrenceInvoiced)}
          disabled={isPending}
          className={buttonClass}
        >
          {isPending ? "Marcando…" : "Marcar Facturado"}
        </button>
      ) : null}
      {status === "invoiced" ? (
        <button
          type="button"
          onClick={() => handleClick(markOccurrenceCollected)}
          disabled={isPending}
          className={buttonClass}
        >
          {isPending ? "Marcando…" : "Marcar Cobrado"}
        </button>
      ) : null}
      {error ? (
        <p role="alert" className="max-w-[220px] text-right text-[11.5px] text-[var(--color-negative-ink)]">
          {error}
        </p>
      ) : null}
    </div>
  );
}
