"use client";

import { useState, useTransition } from "react";
import { fieldInput } from "@/components/FormField";
import { formatAmount, formatDisplayDate } from "@/lib/paymentStatus";
import { jobBalance, orderJobsForInvoice, type JobBalance } from "@/lib/nubox";
import {
  linkInvoiceAction,
  markPaidAction,
  pairCreditNoteAction,
  type PendingActionResult,
} from "./actions";

const buttonClass =
  "whitespace-nowrap text-[12.5px] font-medium text-[var(--color-accent-strong)] disabled:opacity-50";

function useAction() {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function run(action: () => Promise<PendingActionResult>) {
    setError(null);
    startTransition(async () => {
      try {
        const result = await action();
        if (result.error) setError(result.error);
      } catch (thrown) {
        setError(thrown instanceof Error ? thrown.message : "No se pudo completar la acción.");
      }
    });
  }

  return { error, pending, run };
}

function RowError({ error }: { error: string | null }) {
  return error ? (
    <p role="alert" className="mt-1 text-[11.5px] text-[var(--color-negative-ink)]">
      {error}
    </p>
  ) : null;
}

export function PairCreditNoteForm({
  companyId,
  creditNoteId,
  candidates,
}: {
  companyId: string;
  creditNoteId: string;
  candidates: { id: string; documentNumber: string; documentDate: string }[];
}) {
  const [invoiceId, setInvoiceId] = useState(candidates.length === 1 ? candidates[0].id : "");
  const { error, pending, run } = useAction();

  if (candidates.length === 0) {
    return (
      <span className="text-[12.5px] text-[var(--color-warning-ink)]">
        Sin factura candidata (mismo cliente y neto, no posterior)
      </span>
    );
  }

  return (
    <div>
      <div className="flex items-center gap-2">
        <select
          value={invoiceId}
          disabled={pending}
          aria-label="Factura que anula la nota de crédito"
          onChange={(event) => setInvoiceId(event.target.value)}
          className={`${fieldInput} py-[6px] text-[12.5px]`}
        >
          <option value="">Elegí la factura…</option>
          {candidates.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              Factura {candidate.documentNumber} · {formatDisplayDate(candidate.documentDate)}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={pending || !invoiceId}
          onClick={() => run(() => pairCreditNoteAction(companyId, creditNoteId, invoiceId))}
          className={buttonClass}
        >
          {pending ? "Emparejando…" : "Emparejar"}
        </button>
      </div>
      <RowError error={error} />
    </div>
  );
}

export function LinkInvoiceForm({
  companyId,
  salesDocumentId,
  clientId,
  netAmount,
  jobs,
}: {
  companyId: string;
  salesDocumentId: string;
  clientId: string;
  netAmount: number;
  jobs: JobBalance[];
}) {
  const ordered = orderJobsForInvoice(jobs, clientId, new Map());
  const exact = ordered.filter((job) => jobBalance(job) === netAmount);
  const [projectId, setProjectId] = useState(exact.length === 1 ? exact[0].projectId : "");
  const { error, pending, run } = useAction();

  if (ordered.length === 0) {
    return (
      <span className="text-[12.5px] text-[var(--color-muted)]">
        El cliente no tiene trabajos abiertos: creá el trabajo primero.
      </span>
    );
  }

  return (
    <div>
      <div className="flex items-center gap-2">
        <select
          value={projectId}
          disabled={pending}
          aria-label="Trabajo de la factura"
          onChange={(event) => setProjectId(event.target.value)}
          className={`${fieldInput} py-[6px] text-[12.5px]`}
        >
          <option value="">Elegí el trabajo…</option>
          {ordered.map((job) => {
            const balance = jobBalance(job);
            return (
              <option key={job.projectId} value={job.projectId}>
                {job.name}
                {balance === null ? " · sin monto cotizado" : ` · saldo ${formatAmount(balance)}`}
                {job.projectId === exact[0]?.projectId && exact.length === 1 ? " · sugerido" : ""}
              </option>
            );
          })}
        </select>
        <button
          type="button"
          disabled={pending || !projectId}
          onClick={() => run(() => linkInvoiceAction(companyId, salesDocumentId, projectId))}
          className={buttonClass}
        >
          {pending ? "Vinculando…" : "Vincular"}
        </button>
      </div>
      <RowError error={error} />
    </div>
  );
}

export function MarkPaidForm({
  companyId,
  salesDocumentId,
}: {
  companyId: string;
  salesDocumentId: string;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const [paidAt, setPaidAt] = useState(today);
  const [method, setMethod] = useState("");
  const { error, pending, run } = useAction();

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="date"
          value={paidAt}
          disabled={pending}
          aria-label="Fecha de pago"
          onChange={(event) => setPaidAt(event.target.value)}
          className={`${fieldInput} py-[6px] font-mono text-[12.5px]`}
        />
        <input
          type="text"
          value={method}
          disabled={pending}
          placeholder="Medio (transferencia…)"
          aria-label="Medio de pago"
          onChange={(event) => setMethod(event.target.value)}
          className={`${fieldInput} w-40 py-[6px] text-[12.5px]`}
        />
        <button
          type="button"
          disabled={pending || !paidAt}
          onClick={() => run(() => markPaidAction(companyId, salesDocumentId, paidAt, method))}
          className={buttonClass}
        >
          {pending ? "Guardando…" : "Marcar pagada"}
        </button>
      </div>
      <RowError error={error} />
    </div>
  );
}
