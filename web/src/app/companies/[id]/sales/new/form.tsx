"use client";

import Link from "next/link";
import { useActionState, useState, type FormEvent } from "react";
import type { Client, ProjectWithRelations } from "@/lib/dal";
import { Button } from "@/components/Button";
import {
  createSalesDocument,
  type CreateSalesDocumentState,
  type SalesLineInput,
} from "./actions";
import { CURRENCIES } from "@/lib/currencies";
import { DatePicker } from "@/components/DatePicker";

const DOCUMENT_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: "manual", label: "Manual" },
  { value: "invoice", label: "Factura" },
  { value: "receipt", label: "Recibo" },
  { value: "credit_note", label: "Nota de crédito" },
];

const label = "font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--color-muted)]";
const input =
  "rounded-lg border border-[var(--color-hairline)] bg-[var(--color-surface)] px-3 py-[9px] text-[13.5px] text-[var(--color-ink)] outline-none focus:border-[var(--color-ink)] disabled:bg-[var(--color-canvas)] disabled:text-[var(--color-muted)]";

function emptyLine(): SalesLineInput {
  return { description: "", amount: "" };
}

export function NewSalesDocumentForm({
  companyId,
  clients,
  projects,
  defaultCurrency,
}: {
  companyId: string;
  clients: Client[];
  projects: ProjectWithRelations[];
  defaultCurrency: string;
}) {
  const createSalesDocumentWithCompany = createSalesDocument.bind(
    null,
    companyId,
  );

  const initialState: CreateSalesDocumentState = {
    error: null,
    values: {
      client_id: "",
      project_id: "",
      document_type: "manual",
      document_date: "",
      currency: defaultCurrency,
      tax_amount: "",
      lines: [emptyLine()],
    },
  };

  const [state, formAction, pending] = useActionState(
    createSalesDocumentWithCompany,
    initialState,
  );

  const [lines, setLines] = useState<SalesLineInput[]>(
    state.values.lines.length > 0 ? state.values.lines : [emptyLine()],
  );

  // The project picker is filtered to the selected client's own
  // projects (spec: "options filtered to the chosen client's own
  // active projects") -- tracked client-side since the client select
  // can change without a page reload.
  const [selectedClientId, setSelectedClientId] = useState(
    state.values.client_id,
  );
  const [selectedProjectId, setSelectedProjectId] = useState(
    state.values.project_id,
  );
  const clientProjects = projects.filter(
    (project) => project.client_id === selectedClientId,
  );

  const netTotal = lines.reduce((sum, line) => {
    const amount = Number(line.amount);
    return sum + (Number.isFinite(amount) && amount > 0 ? amount : 0);
  }, 0);

  // Friendlier than the raw DB exception from create_sales_document's
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

  return (
    <form action={formAction} onSubmit={handleSubmit} className="flex flex-col gap-5 p-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="client_id" className={label}>
            Cliente *
          </label>
          <select
            id="client_id"
            name="client_id"
            required
            value={selectedClientId}
            onChange={(event) => {
              setSelectedClientId(event.target.value);
              setSelectedProjectId("");
            }}
            className={input}
          >
            <option value="" disabled>
              Elegí un cliente
            </option>
            {clients.map((client) => (
              <option key={client.id} value={client.id}>
                {client.name}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="project_id" className={label}>
            Proyecto
          </label>
          <select
            id="project_id"
            name="project_id"
            value={selectedProjectId}
            onChange={(event) => setSelectedProjectId(event.target.value)}
            disabled={!selectedClientId}
            className={input}
          >
            <option value="">Sin proyecto</option>
            {clientProjects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
          {selectedClientId && clientProjects.length === 0 ? (
            <p className="text-[11.5px] text-[var(--color-muted)]">
              Este cliente no tiene proyectos activos.
            </p>
          ) : null}
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="document_type" className={label}>
            Tipo
          </label>
          <select
            id="document_type"
            name="document_type"
            required
            defaultValue={state.values.document_type}
            className={input}
          >
            {DOCUMENT_TYPE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-[1.4fr_1fr] gap-3">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="document_date" className={label}>
              Fecha
            </label>
            <DatePicker
              id="document_date"
              name="document_date"
              required
              defaultValue={state.values.document_date}
              className={`${input} w-full text-left font-mono`}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="currency" className={label}>
              Moneda
            </label>
            <select
              id="currency"
              name="currency"
              required
              defaultValue={state.values.currency}
              className={input}
            >
              {CURRENCIES.map((currency) => (
                <option key={currency} value={currency}>
                  {currency}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-2 rounded-[10px] border border-[var(--color-hairline)]">
        <div className="flex items-center justify-between border-b border-[var(--color-hairline-soft)] px-4 py-2.5">
          <span className={label}>LÍNEAS</span>
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
            <label htmlFor="tax_amount" className={label}>
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

      <div className="flex items-center gap-3">
        <Button type="submit" pending={pending} pendingLabel="Guardando…" className="flex-1">
          Crear documento
        </Button>
        <Link
          href={`/companies/${companyId}/sales`}
          className="text-[13px] text-[var(--color-muted)] hover:text-[var(--color-ink)]"
        >
          Cancelar
        </Link>
      </div>
    </form>
  );
}
