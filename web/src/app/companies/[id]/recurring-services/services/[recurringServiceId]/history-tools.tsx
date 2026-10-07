"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { fieldInput } from "@/components/FormField";
import { monthLabel } from "@/lib/period";
import { bulkMarkCounts } from "@/lib/recurringServicePending";
import {
  bulkMarkOccurrences,
  undoBulkMarkOccurrences,
  voidOccurrencesBeforeStart,
} from "../../occurrence-actions";

type Cycle = { status: string; invoice_due_date: string | null; period: string };

const secondaryButton =
  "min-h-10 rounded-lg border border-[var(--color-hairline)] bg-[var(--color-surface)] px-3 py-1.5 text-[13px] font-medium text-[var(--color-ink)] hover:border-[var(--color-border-hover)] disabled:opacity-60 md:min-h-0";
const textButton =
  "cursor-pointer px-1 text-[12.5px] font-medium text-[var(--color-accent-strong)] disabled:cursor-default disabled:opacity-60";

/**
 * "Marcar como facturado / cobrado hasta [mes]" over this service's
 * history: every open cycle due up to that month (inclusive), stamped
 * with its own due date. Asks first, says how many, and offers to undo.
 */
export function BulkMarkBar({
  companyId,
  serviceId,
  cycles,
  months,
  defaultMonth,
}: {
  companyId: string;
  serviceId: string;
  cycles: Cycle[];
  /** Months to offer ("YYYY-MM"), newest first. */
  months: string[];
  defaultMonth: string;
}) {
  const router = useRouter();
  const [month, setMonth] = useState(defaultMonth);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [last, setLast] = useState<{ batchId: string; message: string } | null>(null);
  const counts = bulkMarkCounts(cycles, month);

  function mark(action: "invoice" | "collect") {
    const count = action === "invoice" ? counts.invoice : counts.collect;
    const verb = action === "invoice" ? "facturados" : "cobrados";
    if (
      !window.confirm(
        `¿Marcar como ${verb} ${count} ${count === 1 ? "ciclo" : "ciclos"} hasta ${monthLabel(month)} inclusive? ` +
          "Cada uno queda con su fecha de vencimiento. Se puede deshacer.",
      )
    ) {
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await bulkMarkOccurrences(companyId, serviceId, month, action);
      if (result.error) {
        setError(result.error);
        return;
      }
      setLast(
        result.batchId
          ? { batchId: result.batchId, message: `${result.changed} ${result.changed === 1 ? "ciclo marcado" : "ciclos marcados"} como ${verb}.` }
          : null,
      );
      router.refresh();
    });
  }

  function undo() {
    if (!last) return;
    setError(null);
    startTransition(async () => {
      const result = await undoBulkMarkOccurrences(companyId, serviceId, last.batchId);
      if (result.error) {
        setError(result.error);
        return;
      }
      setLast(null);
      router.refresh();
    });
  }

  if (months.length === 0) return null;

  return (
    <div className="flex flex-col gap-2 rounded-[10px] border border-[var(--color-hairline)] bg-[var(--color-surface)] p-3">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="bulk-month" className="text-[12.5px] text-[var(--color-ink-2)]">
          Hasta
        </label>
        <select
          id="bulk-month"
          value={month}
          onChange={(event) => setMonth(event.target.value)}
          className={fieldInput}
        >
          {months.map((m) => (
            <option key={m} value={m}>
              {monthLabel(m)}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={isPending || counts.invoice === 0}
          onClick={() => mark("invoice")}
          className={secondaryButton}
        >
          Marcar como facturado ({counts.invoice})
        </button>
        <button
          type="button"
          disabled={isPending || counts.collect === 0}
          onClick={() => mark("collect")}
          className={secondaryButton}
        >
          Marcar como cobrado ({counts.collect})
        </button>
        {isPending ? <span className="text-[12px] text-[var(--color-muted)]">Guardando…</span> : null}
      </div>
      {last ? (
        <p role="status" className="text-[12.5px] text-[var(--color-ink-2)]">
          {last.message}{" "}
          <button type="button" disabled={isPending} onClick={undo} className={textButton}>
            Deshacer
          </button>
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-[12px] text-[var(--color-negative-ink)]">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Offers to void the still-open cycles left before a start date that was moved forward. */
export function VoidBeforeStartButton({
  companyId,
  serviceId,
  openCount,
}: {
  companyId: string;
  serviceId: string;
  openCount: number;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (openCount === 0) return null;

  return (
    <>
      <button
        type="button"
        disabled={isPending}
        onClick={() => {
          if (
            !window.confirm(
              `¿Anular ${openCount} ${openCount === 1 ? "ciclo" : "ciclos"} sin cobrar anteriores al inicio? No se borran: quedan anulados y no se vuelven a generar.`,
            )
          ) {
            return;
          }
          setError(null);
          startTransition(async () => {
            const result = await voidOccurrencesBeforeStart(companyId, serviceId);
            if (result.error) {
              setError(result.error);
              return;
            }
            router.refresh();
          });
        }}
        className={secondaryButton}
      >
        {isPending ? "Anulando…" : `Anular ${openCount} sin cobrar`}
      </button>
      {error ? (
        <span role="alert" className="text-[12px] text-[var(--color-negative-ink)]">
          {error}
        </span>
      ) : null}
    </>
  );
}
