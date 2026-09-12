"use client";

import Link from "next/link";
import { useActionState, useState, type FormEvent } from "react";
import type { Client, SalesDocumentWithLines } from "@/lib/dal";
import {
  updateSalesDocument,
  voidSalesDocument,
  type EditSalesDocumentState,
  type SalesLineInput,
  type VoidSalesDocumentState,
} from "./actions";

const DOCUMENT_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: "manual", label: "Manual" },
  { value: "invoice", label: "Invoice" },
  { value: "receipt", label: "Receipt" },
  { value: "credit_note", label: "Credit note" },
];

function emptyLine(): SalesLineInput {
  return { description: "", amount: "" };
}

export function EditSalesDocumentForm({
  companyId,
  document,
  clients,
}: {
  companyId: string;
  document: SalesDocumentWithLines;
  clients: Client[];
}) {
  const updateSalesDocumentWithIds = updateSalesDocument.bind(
    null,
    companyId,
    document.id,
  );

  const initialState: EditSalesDocumentState = {
    error: null,
    values: {
      client_id: document.client_id,
      document_type: document.document_type,
      document_date: document.document_date,
      currency: document.currency,
      tax_amount: String(document.tax_amount),
      lines:
        document.lines.length > 0
          ? document.lines.map((line) => ({
              description: line.description ?? "",
              amount: String(line.amount),
            }))
          : [emptyLine()],
    },
  };

  const [state, formAction, pending] = useActionState(
    updateSalesDocumentWithIds,
    initialState,
  );

  const [lines, setLines] = useState<SalesLineInput[]>(
    state.values.lines.length > 0 ? state.values.lines : [emptyLine()],
  );

  const netTotal = lines.reduce((sum, line) => {
    const amount = Number(line.amount);
    return sum + (Number.isFinite(amount) && amount > 0 ? amount : 0);
  }, 0);

  const hasInvalidLineAmount = lines.some((line) => {
    if (line.amount.trim() === "") return false;
    const amount = Number(line.amount);
    return !Number.isFinite(amount) || amount <= 0;
  });

  const [clientError, setClientError] = useState<string | null>(null);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    if (hasInvalidLineAmount) {
      event.preventDefault();
      setClientError("Each line amount must be greater than zero.");
      return;
    }
    setClientError(null);
  }

  function updateLine(index: number, patch: Partial<SalesLineInput>) {
    setLines((prev) =>
      prev.map((line, i) => (i === index ? { ...line, ...patch } : line)),
    );
  }

  function addLine() {
    setLines((prev) => [...prev, emptyLine()]);
  }

  function removeLine(index: number) {
    setLines((prev) =>
      prev.length > 1 ? prev.filter((_, i) => i !== index) : prev,
    );
  }

  const isEdited = document.updated_at !== document.created_at;

  return (
    <div className="flex flex-col gap-6">
      {isEdited ? (
        <span className="w-fit rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-950 dark:text-amber-400">
          Edited
        </span>
      ) : null}

      <form
        action={formAction}
        onSubmit={handleSubmit}
        className="flex flex-col gap-4"
      >
        <div className="flex flex-col gap-1">
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
            defaultValue={state.values.client_id}
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

        <div className="flex gap-3">
          <div className="flex flex-1 flex-col gap-1">
            <label
              htmlFor="document_type"
              className="text-sm font-medium text-zinc-700 dark:text-zinc-300"
            >
              Type
            </label>
            <select
              id="document_type"
              name="document_type"
              required
              defaultValue={state.values.document_type}
              className="rounded border border-black/[.08] bg-transparent px-3 py-2 text-sm text-black outline-none focus:border-zinc-500 dark:border-white/[.145] dark:text-zinc-50"
            >
              {DOCUMENT_TYPE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-1 flex-col gap-1">
            <label
              htmlFor="document_date"
              className="text-sm font-medium text-zinc-700 dark:text-zinc-300"
            >
              Date
            </label>
            <input
              id="document_date"
              name="document_date"
              type="date"
              required
              defaultValue={state.values.document_date}
              className="rounded border border-black/[.08] bg-transparent px-3 py-2 text-sm text-black outline-none focus:border-zinc-500 dark:border-white/[.145] dark:text-zinc-50"
            />
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <label
            htmlFor="currency"
            className="text-sm font-medium text-zinc-700 dark:text-zinc-300"
          >
            Currency
          </label>
          <input
            id="currency"
            name="currency"
            type="text"
            required
            defaultValue={state.values.currency}
            className="rounded border border-black/[.08] bg-transparent px-3 py-2 text-sm text-black outline-none focus:border-zinc-500 dark:border-white/[.145] dark:text-zinc-50"
          />
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
              Lines
            </span>
            <button
              type="button"
              onClick={addLine}
              className="text-sm font-medium text-zinc-700 underline underline-offset-2 hover:text-black dark:text-zinc-300 dark:hover:text-zinc-50"
            >
              Add line
            </button>
          </div>
          {lines.map((line, index) => (
            <div key={index} className="flex items-end gap-2">
              <div className="flex flex-1 flex-col gap-1">
                {index === 0 ? (
                  <label className="text-xs text-zinc-500 dark:text-zinc-500">
                    Description
                  </label>
                ) : null}
                <input
                  name="line_description"
                  type="text"
                  value={line.description}
                  onChange={(event) =>
                    updateLine(index, { description: event.target.value })
                  }
                  className="rounded border border-black/[.08] bg-transparent px-3 py-2 text-sm text-black outline-none focus:border-zinc-500 dark:border-white/[.145] dark:text-zinc-50"
                />
              </div>
              <div className="flex w-32 flex-col gap-1">
                {index === 0 ? (
                  <label className="text-xs text-zinc-500 dark:text-zinc-500">
                    Amount
                  </label>
                ) : null}
                <input
                  name="line_amount"
                  type="number"
                  step="0.01"
                  value={line.amount}
                  onChange={(event) =>
                    updateLine(index, { amount: event.target.value })
                  }
                  className="rounded border border-black/[.08] bg-transparent px-3 py-2 text-sm text-black outline-none focus:border-zinc-500 dark:border-white/[.145] dark:text-zinc-50"
                />
              </div>
              <button
                type="button"
                onClick={() => removeLine(index)}
                disabled={lines.length <= 1}
                className="h-9 px-2 text-sm text-zinc-500 hover:text-red-600 disabled:opacity-40 dark:text-zinc-500 dark:hover:text-red-400"
                aria-label="Remove line"
              >
                Remove
              </button>
            </div>
          ))}
        </div>

        <div className="flex flex-col gap-1">
          <label
            htmlFor="tax_amount"
            className="text-sm font-medium text-zinc-700 dark:text-zinc-300"
          >
            Tax amount
          </label>
          <input
            id="tax_amount"
            name="tax_amount"
            type="number"
            step="0.01"
            defaultValue={state.values.tax_amount}
            className="rounded border border-black/[.08] bg-transparent px-3 py-2 text-sm text-black outline-none focus:border-zinc-500 dark:border-white/[.145] dark:text-zinc-50"
          />
        </div>

        <p className="text-sm text-zinc-500 dark:text-zinc-500">
          Net total (computed from lines): {netTotal.toFixed(2)}
        </p>

        {clientError ? (
          <p className="text-sm text-red-600 dark:text-red-400" role="alert">
            {clientError}
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
            className="flex h-10 flex-1 items-center justify-center rounded-full bg-foreground px-5 text-sm font-medium text-background transition-colors hover:bg-[#383838] disabled:opacity-60 dark:hover:bg-[#ccc]"
          >
            {pending ? "Saving..." : "Save changes"}
          </button>
          <Link
            href={`/companies/${companyId}/sales`}
            className="text-sm text-zinc-600 hover:text-black dark:text-zinc-400 dark:hover:text-zinc-50"
          >
            Cancel
          </Link>
        </div>
      </form>

      <VoidDocumentSection companyId={companyId} salesDocumentId={document.id} />
    </div>
  );
}

function VoidDocumentSection({
  companyId,
  salesDocumentId,
}: {
  companyId: string;
  salesDocumentId: string;
}) {
  const voidSalesDocumentWithIds = voidSalesDocument.bind(
    null,
    companyId,
    salesDocumentId,
  );

  const initialState: VoidSalesDocumentState = { error: null };
  const [state, formAction, pending] = useActionState(
    voidSalesDocumentWithIds,
    initialState,
  );
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="flex flex-col gap-2 rounded-md border border-red-200 p-4 dark:border-red-900">
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        Voiding removes this document from active use without deleting it --
        it stays visible in the list with a &quot;Voided&quot; badge and can
        no longer be edited.
      </p>

      {state.error ? (
        <p className="text-sm text-red-600 dark:text-red-400" role="alert">
          {state.error}
        </p>
      ) : null}

      {confirming ? (
        <form action={formAction} className="flex items-center gap-3">
          <p className="text-sm font-medium text-red-700 dark:text-red-400">
            Are you sure? This cannot be undone.
          </p>
          <button
            type="submit"
            disabled={pending}
            className="rounded-full bg-red-600 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-60"
          >
            {pending ? "Voiding..." : "Yes, void it"}
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            className="text-sm text-zinc-600 hover:text-black dark:text-zinc-400 dark:hover:text-zinc-50"
          >
            Cancel
          </button>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="w-fit rounded-full border border-red-300 px-4 py-1.5 text-sm font-medium text-red-700 transition-colors hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950"
        >
          Void this document
        </button>
      )}
    </div>
  );
}
