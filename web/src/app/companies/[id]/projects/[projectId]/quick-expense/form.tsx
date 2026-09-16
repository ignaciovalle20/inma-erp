"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import {
  createQuickCostDocument,
  type CreateQuickCostDocumentState,
} from "./actions";
import { Field, FormActions, fieldInput, fieldLabel } from "@/components/FormField";

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
  const [receiptName, setReceiptName] = useState<string | null>(null);
  // Same reset-in-place trick as the quick sales entry form: bumping
  // this key remounts amount/category/description with fresh
  // defaultValues after a successful save, so the form is ready for the
  // next expense without a full page reload. The date field keeps its
  // value instead of clearing (handled separately below).
  const [resetKey, setResetKey] = useState(0);

  useEffect(() => {
    if (state.success) {
      setResetKey((key) => key + 1);
      setReceiptName(null);
      if (dateRef.current) {
        dateRef.current.value = state.values.document_date;
      }
    }
  }, [state]);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <div key={`amount-${resetKey}`}>
        <Field label="Monto" htmlFor="amount">
          <input
            id="amount"
            name="amount"
            type="number"
            inputMode="decimal"
            step="0.01"
            min="0.01"
            required
            autoFocus
            autoComplete="off"
            defaultValue=""
            className={`${fieldInput} text-[17px]`}
          />
        </Field>
      </div>

      <fieldset className="flex flex-col gap-1.5" key={`category-${resetKey}`}>
        <legend className={fieldLabel}>Categoría</legend>
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
              <span className="inline-flex items-center rounded-full border border-[var(--color-hairline)] bg-[var(--color-surface)] px-3.5 py-2 text-[13px] text-[var(--color-ink)] transition-colors peer-checked:border-[var(--color-ink)] peer-checked:bg-[var(--color-ink)] peer-checked:text-[var(--color-on-ink)]">
                {option.label}
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <Field label="Fecha" htmlFor="document_date">
        <input
          ref={dateRef}
          id="document_date"
          name="document_date"
          type="date"
          required
          defaultValue={state.values.document_date}
          className={`${fieldInput} font-mono`}
        />
      </Field>

      <div key={`description-${resetKey}`}>
        <Field label="Descripción (opcional)" htmlFor="description">
          <input
            id="description"
            name="description"
            type="text"
            defaultValue=""
            className={fieldInput}
          />
        </Field>
      </div>

      <div key={`receipt-${resetKey}`}>
        <Field label="Comprobante (opcional)" htmlFor="receipt">
          <div className="flex items-center gap-3 text-[13px] text-[var(--color-muted)]">
            <label
              htmlFor="receipt"
              className="cursor-pointer rounded-full bg-[var(--color-row)] px-3.5 py-2 text-[13px] font-medium text-[var(--color-ink)]"
            >
              Elegir archivo
            </label>
            <span>{receiptName ?? "Sin archivo elegido"}</span>
          </div>
          <input
            id="receipt"
            name="receipt"
            type="file"
            accept="image/*"
            capture="environment"
            onChange={(event) => setReceiptName(event.target.files?.[0]?.name ?? null)}
            className="hidden"
          />
        </Field>
      </div>

      {state.success ? (
        <p className="text-[13px] text-[var(--color-accent-strong)]" role="status">
          Gasto guardado.
        </p>
      ) : null}

      {state.error ? (
        <p className="text-[13px] text-[var(--color-negative-ink)]" role="alert">
          {state.error}
        </p>
      ) : null}

      <FormActions
        cancelHref={`/companies/${companyId}/projects/${projectId}`}
        pending={pending}
        pendingLabel="Guardando…"
      >
        Guardar
      </FormActions>
    </form>
  );
}
