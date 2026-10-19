"use client";

import { useActionState } from "react";
import { addProjectQuote, type AddProjectQuoteState } from "./actions";
import { fieldInput } from "@/components/FormField";
import { AmountInput } from "@/components/AmountInput";

const initialState: AddProjectQuoteState = { error: null };

export function AddQuoteForm({
  companyId,
  projectId,
}: {
  companyId: string;
  projectId: string;
}) {
  const addQuoteWithIds = addProjectQuote.bind(null, companyId, projectId);
  const [state, formAction, pending] = useActionState(addQuoteWithIds, initialState);

  return (
    <form action={formAction} className="flex items-center gap-2">
      <input
        name="quote_number"
        type="text"
        placeholder="N° de cotización"
        required
        className={`${fieldInput} w-40 font-mono`}
      />
      <AmountInput
        name="quoted_amount"
        placeholder="Monto (opcional)"
        aria-label="Monto cotizado (neto)"
        maxDecimals={2}
        className={`${fieldInput} w-36 font-mono`}
      />
      <button
        type="submit"
        disabled={pending}
        className="text-[12.5px] font-medium text-[var(--color-accent-strong)] disabled:opacity-60"
      >
        {pending ? "Agregando…" : "+ Agregar cotización"}
      </button>
      {state.error ? (
        <span role="alert" className="text-[12px] text-[var(--color-negative-ink)]">
          {state.error}
        </span>
      ) : null}
    </form>
  );
}
