"use client";

import { useActionState, useState, type FormEvent } from "react";
import type { ProjectWithRelations, Supplier } from "@/lib/dal";
import {
  createCostDocument,
  type CostLineInput,
  type CreateCostDocumentState,
} from "./actions";
import { Field, FormActions, fieldInput, fieldLabel } from "@/components/FormField";
import { CURRENCIES } from "@/lib/currencies";
import { DatePicker } from "@/components/DatePicker";

function emptyLine(): CostLineInput {
  return { description: "", amount: "" };
}

export function NewCostDocumentForm({
  companyId,
  suppliers,
  projects,
  defaultCurrency,
}: {
  companyId: string;
  suppliers: Supplier[];
  projects: ProjectWithRelations[];
  defaultCurrency: string;
}) {
  const createCostDocumentWithCompany = createCostDocument.bind(null, companyId);

  const initialState: CreateCostDocumentState = {
    error: null,
    duplicateWarning: null,
    values: {
      supplier_id: "",
      project_id: "",
      classification: "direct",
      document_date: "",
      currency: defaultCurrency,
      tax_amount: "",
      lines: [emptyLine()],
    },
  };

  const [state, formAction, pending] = useActionState(
    createCostDocumentWithCompany,
    initialState,
  );

  const [classification, setClassification] = useState(
    state.values.classification,
  );
  const [projectId, setProjectId] = useState(state.values.project_id);
  const [supplierId, setSupplierId] = useState(state.values.supplier_id);

  const [lines, setLines] = useState<CostLineInput[]>(
    state.values.lines.length > 0 ? state.values.lines : [emptyLine()],
  );

  const netTotal = lines.reduce((sum, line) => {
    const amount = Number(line.amount);
    return sum + (Number.isFinite(amount) && amount > 0 ? amount : 0);
  }, 0);

  // Friendlier than the raw DB exception from create_cost_document's
  // "Line amount must be greater than zero" check -- catch it before
  // submit for any line the user actually filled in.
  const hasInvalidLineAmount = lines.some((line) => {
    if (line.amount.trim() === "") return false;
    const amount = Number(line.amount);
    return !Number.isFinite(amount) || amount <= 0;
  });

  const [clientError, setClientError] = useState<string | null>(null);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    if (hasInvalidLineAmount) {
      event.preventDefault();
      setClientError("Cada línea debe tener un importe mayor a cero.");
      return;
    }

    if (classification === "direct" && !projectId) {
      event.preventDefault();
      setClientError("Un costo directo necesita un proyecto.");
      return;
    }

    if (classification === "general" && projectId) {
      event.preventDefault();
      setClientError("Un costo general no puede tener proyecto.");
      return;
    }

    setClientError(null);
  }

  function updateLine(index: number, patch: Partial<CostLineInput>) {
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

  return (
    <form action={formAction} onSubmit={handleSubmit} className="flex flex-col gap-5 p-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="¿A quién corresponde este costo?" htmlFor="classification">
          <input type="hidden" id="classification" name="classification" value={classification} />
          <div className="flex overflow-hidden rounded-[7px] border border-[var(--color-hairline)]">
            <button
              type="button"
              onClick={() => setClassification("direct")}
              aria-pressed={classification === "direct"}
              className={`flex-1 px-3 py-2 text-[13px] font-medium transition-colors ${
                classification === "direct"
                  ? "bg-[var(--color-ink)] text-[var(--color-on-ink)]"
                  : "bg-[var(--color-surface)] text-[var(--color-ink)]"
              }`}
            >
              Todo a este trabajo
            </button>
            <button
              type="button"
              onClick={() => {
                setClassification("general");
                setProjectId("");
              }}
              aria-pressed={classification === "general"}
              className={`flex-1 border-l border-[var(--color-hairline)] px-3 py-2 text-[13px] font-medium transition-colors ${
                classification === "general"
                  ? "bg-[var(--color-ink)] text-[var(--color-on-ink)]"
                  : "bg-[var(--color-surface)] text-[var(--color-ink)]"
              }`}
            >
              Dividir costo
            </button>
          </div>
          {classification === "general" ? (
            <p className="text-[11.5px] text-[var(--color-muted)]">
              Vas a repartir este costo entre varios trabajos, clientes o
              áreas en el siguiente paso.
            </p>
          ) : null}
        </Field>

        {classification === "direct" ? (
          <Field
            label="Proyecto"
            htmlFor="project_id"
            hint={
              projects.length === 0
                ? undefined
                : undefined
            }
          >
            <select
              id="project_id"
              name="project_id"
              required
              value={projectId}
              onChange={(event) => setProjectId(event.target.value)}
              className={fieldInput}
            >
              <option value="" disabled>
                Elegí un proyecto
              </option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
            {projects.length === 0 ? (
              <p className="text-[11.5px] text-[var(--color-muted)]">
                No hay proyectos activos --{" "}
                <a className="text-[var(--color-accent-strong)]" href={`/companies/${companyId}/projects`}>
                  agregá uno primero
                </a>
                .
              </p>
            ) : null}
          </Field>
        ) : null}

        <Field label="Proveedor" htmlFor="supplier_id">
          <select
            id="supplier_id"
            name="supplier_id"
            value={supplierId}
            onChange={(event) => setSupplierId(event.target.value)}
            className={fieldInput}
          >
            <option value="">Sin proveedor</option>
            {suppliers.map((supplier) => (
              <option key={supplier.id} value={supplier.id}>
                {supplier.name}
              </option>
            ))}
          </select>
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Fecha" htmlFor="document_date">
            <DatePicker
              id="document_date"
              name="document_date"
              required
              defaultValue={state.values.document_date}
              className={`${fieldInput} w-full text-left font-mono`}
            />
          </Field>
          <Field label="Moneda" htmlFor="currency">
            <select
              id="currency"
              name="currency"
              required
              defaultValue={state.values.currency}
              className={fieldInput}
            >
              {CURRENCIES.map((currency) => (
                <option key={currency} value={currency}>
                  {currency}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </div>

      <div className="flex flex-col gap-2 rounded-[10px] border border-[var(--color-hairline)]">
        <div className="flex items-center justify-between border-b border-[var(--color-hairline-soft)] px-4 py-2.5">
          <span className={fieldLabel}>LÍNEAS</span>
          <button
            type="button"
            onClick={addLine}
            className="text-[13px] font-medium text-[var(--color-accent-strong)]"
          >
            + Agregar línea
          </button>
        </div>
        <div className="flex flex-col gap-2 p-3">
          {lines.map((line, index) => (
            <div key={index} className="flex items-center gap-2">
              <input
                name="line_description"
                type="text"
                placeholder="Descripción"
                value={line.description}
                onChange={(event) =>
                  updateLine(index, { description: event.target.value })
                }
                className="flex-1 rounded-[7px] border border-[var(--color-hairline-soft)] bg-[var(--color-surface-muted)] px-3 py-2 text-[13.5px] outline-none focus:border-[var(--color-ink)]"
              />
              <input
                name="line_amount"
                type="number"
                step="0.01"
                placeholder="0.00"
                value={line.amount}
                onChange={(event) =>
                  updateLine(index, { amount: event.target.value })
                }
                className="w-[150px] rounded-[7px] border border-[var(--color-hairline-soft)] bg-[var(--color-surface-muted)] px-3 py-2 text-right font-mono text-[13px] outline-none focus:border-[var(--color-ink)]"
              />
              <button
                type="button"
                onClick={() => removeLine(index)}
                disabled={lines.length <= 1}
                className="px-1 text-[13px] text-[var(--color-muted)] hover:text-[var(--color-negative-ink)] disabled:opacity-40"
                aria-label="Quitar línea"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
        <div className="flex items-center justify-between gap-4 border-t border-[var(--color-hairline-soft)] bg-[var(--color-surface-muted)] px-4 py-3">
          <span className="text-[12.5px] text-[var(--color-muted)]">
            Neto (suma de líneas): <span className="font-mono">{netTotal.toFixed(2)}</span>
          </span>
          <div className="flex items-center gap-2">
            <label htmlFor="tax_amount" className={fieldLabel}>
              IVA
            </label>
            <input
              id="tax_amount"
              name="tax_amount"
              type="number"
              step="0.01"
              defaultValue={state.values.tax_amount}
              className="w-28 rounded-[7px] border border-[var(--color-hairline)] bg-[var(--color-surface)] px-2 py-1.5 text-right font-mono text-[13px] outline-none focus:border-[var(--color-ink)]"
            />
          </div>
        </div>
      </div>

      {clientError ? (
        <p className="text-[13px] text-[var(--color-negative-ink)]" role="alert">
          {clientError}
        </p>
      ) : null}

      {state.error ? (
        <p className="text-[13px] text-[var(--color-negative-ink)]" role="alert">
          {state.error}
        </p>
      ) : null}

      {state.duplicateWarning ? (
        <div
          role="alert"
          className="rounded-lg border border-[var(--color-warning-soft-border)] bg-[var(--color-warning-soft)] px-3 py-2.5 text-[13px] text-[var(--color-warning-ink)]"
        >
          <p className="font-semibold">Posible duplicado</p>
          <p>
            Un documento de costo {state.duplicateWarning.classification} existente
            del {state.duplicateWarning.document_date} por{" "}
            {state.duplicateWarning.total_amount.toFixed(2)}{" "}
            {state.duplicateWarning.currency} coincide en proveedor, fecha y
            total.
          </p>
        </div>
      ) : null}

      <input
        type="hidden"
        name="confirm_duplicate"
        value={state.duplicateWarning ? "true" : "false"}
      />

      <FormActions
        cancelHref={`/companies/${companyId}/costs`}
        pending={pending}
        pendingLabel="Guardando…"
      >
        {state.duplicateWarning ? "Guardar igual" : "Crear documento"}
      </FormActions>
    </form>
  );
}
