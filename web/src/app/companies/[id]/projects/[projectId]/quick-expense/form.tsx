"use client";

import Link from "next/link";
import { useActionState, useEffect, useRef, useState } from "react";
import {
  createQuickCostDocument,
  type CreateQuickCostDocumentState,
} from "./actions";

const CATEGORY_OPTIONS: { value: string; label: string }[] = [
  { value: "equipment", label: "Equipos" },
  { value: "materials", label: "Materiales" },
  { value: "transport", label: "Traslados" },
  { value: "labor", label: "Mano de obra" },
  { value: "other", label: "Otros" },
];

// Local calendar date, not UTC -- toISOString() shifts to UTC first,
// which rolls over to the next (or previous) day in the evening/early
// morning for any timezone behind/ahead of GMT+0 (Chile, Uruguay, ...).
function today(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

export function QuickCostEntryForm({
  companyId,
  projectId,
}: {
  companyId: string;
  projectId: string;
}) {
  const createQuickCostDocumentWithIds = createQuickCostDocument.bind(
    null,
    companyId,
    projectId,
  );

  const initialState: CreateQuickCostDocumentState = {
    error: null,
    success: false,
    values: {
      amount: "",
      category: "",
      description: "",
      document_date: today(),
    },
  };

  const [state, formAction, pending] = useActionState(
    createQuickCostDocumentWithIds,
    initialState,
  );

  const dateRef = useRef<HTMLInputElement>(null);
  const [showMore, setShowMore] = useState(false);
  // Same reset-in-place trick as the quick sales entry form: bumping
  // this key remounts amount/category/description with fresh
  // defaultValues after a successful save, so the form is ready for the
  // next expense without a full page reload. The date field keeps its
  // value instead of clearing (handled separately below).
  const [resetKey, setResetKey] = useState(0);

  useEffect(() => {
    if (state.success) {
      setResetKey((key) => key + 1);
      if (dateRef.current) {
        dateRef.current.value = state.values.document_date;
      }
    }
  }, [state]);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1" key={`amount-${resetKey}`}>
        <label
          htmlFor="amount"
          className="text-sm font-medium text-zinc-700 dark:text-zinc-300"
        >
          Monto
        </label>
        <input
          id="amount"
          name="amount"
          type="number"
          inputMode="decimal"
          step="0.01"
          min="0.01"
          required
          autoFocus
          defaultValue=""
          className="rounded border border-black/[.08] bg-transparent px-3 py-3 text-lg text-black outline-none focus:border-zinc-500 dark:border-white/[.145] dark:text-zinc-50"
        />
      </div>

      <fieldset className="flex flex-col gap-1" key={`category-${resetKey}`}>
        <legend className="mb-1 text-sm font-medium text-zinc-700 dark:text-zinc-300">
          Categoría
        </legend>
        <div className="flex flex-wrap gap-2">
          {CATEGORY_OPTIONS.map((option) => (
            <label key={option.value} className="cursor-pointer">
              <input
                type="radio"
                name="category"
                value={option.value}
                required
                defaultChecked={false}
                className="peer sr-only"
              />
              <span className="inline-flex items-center rounded-full border border-black/[.08] px-3.5 py-2 text-sm text-black transition-colors peer-checked:border-foreground peer-checked:bg-foreground peer-checked:text-background dark:border-white/[.145] dark:text-zinc-50">
                {option.label}
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="flex flex-col gap-1">
        <label
          htmlFor="document_date"
          className="text-sm font-medium text-zinc-700 dark:text-zinc-300"
        >
          Fecha
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

      <div className="flex flex-col gap-1" key={`receipt-${resetKey}`}>
        <label
          htmlFor="receipt"
          className="text-sm font-medium text-zinc-700 dark:text-zinc-300"
        >
          Comprobante (opcional)
        </label>
        <input
          id="receipt"
          name="receipt"
          type="file"
          accept="image/*"
          capture="environment"
          className="text-sm text-zinc-700 file:mr-3 file:rounded-full file:border-0 file:bg-black/[.05] file:px-3.5 file:py-2 file:text-sm file:font-medium file:text-black dark:text-zinc-300 dark:file:bg-white/[.08] dark:file:text-zinc-50"
        />
      </div>

      {showMore ? (
        <div className="flex flex-col gap-1" key={`description-${resetKey}`}>
          <label
            htmlFor="description"
            className="text-sm font-medium text-zinc-700 dark:text-zinc-300"
          >
            Descripción (opcional)
          </label>
          <input
            id="description"
            name="description"
            type="text"
            defaultValue=""
            className="rounded border border-black/[.08] bg-transparent px-3 py-2 text-sm text-black outline-none focus:border-zinc-500 dark:border-white/[.145] dark:text-zinc-50"
          />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setShowMore(true)}
          className="self-start text-sm text-zinc-600 underline hover:text-black dark:text-zinc-400 dark:hover:text-zinc-50"
        >
          Agregar descripción
        </button>
      )}

      {state.success ? (
        <p className="text-sm text-green-600 dark:text-green-400" role="status">
          Gasto guardado.
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
          className="flex h-11 flex-1 items-center justify-center rounded-full bg-foreground px-5 text-sm font-medium text-background transition-colors hover:bg-[var(--color-primary-hover)] disabled:opacity-60"
        >
          {pending ? "Guardando..." : "Guardar"}
        </button>
        <Link
          href={`/companies/${companyId}/projects/${projectId}`}
          className="text-sm text-zinc-600 hover:text-black dark:text-zinc-400 dark:hover:text-zinc-50"
        >
          Listo
        </Link>
      </div>
    </form>
  );
}
