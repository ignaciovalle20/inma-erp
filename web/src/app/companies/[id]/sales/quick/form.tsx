"use client";

import Link from "next/link";
import { useActionState, useEffect, useRef, useState } from "react";
import type { Client, BusinessArea } from "@/lib/dal";
import {
  createQuickSalesDocument,
  type CreateQuickSalesDocumentState,
} from "./actions";
import { AmountInput } from "@/components/AmountInput";

// Local calendar date, not UTC -- toISOString() shifts to UTC first,
// which rolls over to the next (or previous) day in the evening/early
// morning for any timezone behind/ahead of GMT+0 (Chile, Uruguay, ...).
function today(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

export function QuickSalesEntryForm({
  companyId,
  clients,
  businessAreas,
}: {
  companyId: string;
  clients: Client[];
  businessAreas: BusinessArea[];
}) {
  const createQuickSalesDocumentWithCompany = createQuickSalesDocument.bind(
    null,
    companyId,
  );

  const initialState: CreateQuickSalesDocumentState = {
    error: null,
    success: false,
    values: {
      client_id: "",
      document_date: today(),
      amount: "",
      business_area_id: "",
    },
  };

  const [state, formAction, pending] = useActionState(
    createQuickSalesDocumentWithCompany,
    initialState,
  );

  const formRef = useRef<HTMLFormElement>(null);
  const dateRef = useRef<HTMLInputElement>(null);
  // Bumping this key remounts the client/amount/area fields with fresh
  // defaultValues, which is the reset mechanism -- see the spec's Code
  // Map note that this codebase has no existing "reset-in-place"
  // pattern to reuse. The date field is handled separately below since
  // it must keep its value instead of clearing.
  const [resetKey, setResetKey] = useState(0);

  // Reacting to a new action result: state is adjusted while rendering (the
  // pattern React documents for "state that follows a prop"), not from an
  // effect, which would render the form twice on every save.
  const [handledState, setHandledState] = useState(state);
  if (state !== handledState) {
    setHandledState(state);
    if (state.success) {
      setResetKey((key) => key + 1);
    }
  }

  // Only the DOM write stays in an effect: the date field is uncontrolled and
  // has to keep the date of the sale just saved.
  useEffect(() => {
    if (state.success && dateRef.current) {
      dateRef.current.value = state.values.document_date;
    }
  }, [state]);

  return (
    <form ref={formRef} action={formAction} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1" key={`client-${resetKey}`}>
        <label
          htmlFor="client_id"
          className="text-sm font-medium text-zinc-700 dark:text-zinc-300"
        >
          Client
        </label>
        <select
          id="client_id"
          name="client_id"
          required
          defaultValue=""
          className="rounded border border-black/[.08] bg-transparent px-3 py-2 text-sm text-black outline-none focus:border-zinc-500 dark:border-white/[.145] dark:text-zinc-50"
        >
          <option value="" disabled>
            Select a client
          </option>
          {clients.map((client) => (
            <option key={client.id} value={client.id}>
              {client.name}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-1">
        <label
          htmlFor="document_date"
          className="text-sm font-medium text-zinc-700 dark:text-zinc-300"
        >
          Date
        </label>
        <input
          ref={dateRef}
          id="document_date"
          name="document_date"
          type="date"
          required
          defaultValue={state.values.document_date}
          className="rounded border border-black/[.08] bg-transparent px-3 py-2 text-sm text-black outline-none focus:border-zinc-500 dark:border-white/[.145] dark:text-zinc-50"
        />
      </div>

      <div className="flex flex-col gap-1" key={`amount-${resetKey}`}>
        <label
          htmlFor="amount"
          className="text-sm font-medium text-zinc-700 dark:text-zinc-300"
        >
          Amount
        </label>
        <AmountInput
          id="amount"
          name="amount"
          required
          className="rounded border border-black/[.08] bg-transparent px-3 py-2 text-sm text-black outline-none focus:border-zinc-500 dark:border-white/[.145] dark:text-zinc-50"
        />
      </div>

      <div className="flex flex-col gap-1" key={`area-${resetKey}`}>
        <label
          htmlFor="business_area_id"
          className="text-sm font-medium text-zinc-700 dark:text-zinc-300"
        >
          Business area
        </label>
        <select
          id="business_area_id"
          name="business_area_id"
          required
          defaultValue=""
          className="rounded border border-black/[.08] bg-transparent px-3 py-2 text-sm text-black outline-none focus:border-zinc-500 dark:border-white/[.145] dark:text-zinc-50"
        >
          <option value="" disabled>
            Select a business area
          </option>
          {businessAreas.map((area) => (
            <option key={area.id} value={area.id}>
              {area.name}
            </option>
          ))}
        </select>
      </div>

      {state.success ? (
        <p className="text-sm text-green-600 dark:text-green-400" role="status">
          Saved.
        </p>
      ) : null}

      {state.error ? (
        <p className="text-sm text-red-600 dark:text-red-400" role="alert">
          {state.error}
        </p>
      ) : null}

      <div className="mt-2 flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="flex h-10 flex-1 items-center justify-center rounded-full bg-foreground px-5 text-sm font-medium text-background transition-colors hover:bg-[var(--color-primary-hover)] disabled:opacity-60"
        >
          {pending ? "Saving..." : "Save"}
        </button>
        <Link
          href={`/companies/${companyId}/sales`}
          className="text-sm text-zinc-600 hover:text-black dark:text-zinc-400 dark:hover:text-zinc-50"
        >
          Done
        </Link>
      </div>
    </form>
  );
}
