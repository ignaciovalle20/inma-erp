"use client";

import { useActionState, useState, type FormEvent } from "react";
import type {
  Client,
  ProjectWithRelations,
  SalesDocumentWithLines,
} from "@/lib/dal";
import {
  reassignSalesDocumentPeriod,
  updateSalesDocument,
  voidSalesDocument,
  type EditSalesDocumentState,
  type ReassignPeriodState,
  type SalesLineInput,
  type VoidSalesDocumentState,
} from "./actions";
import { Card } from "@/components/Card";
import { Badge } from "@/components/Badge";
import { Button } from "@/components/Button";
import { FormActions, fieldInput, fieldLabel } from "@/components/FormField";

/** Formats a "YYYY-MM-01" period date as "septiembre 2026". */
function formatPeriod(period: string): string {
  const date = new Date(`${period}T00:00:00Z`);
  return date.toLocaleDateString("es-UY", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

const DOCUMENT_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: "manual", label: "Manual" },
  { value: "invoice", label: "Factura" },
  { value: "receipt", label: "Recibo" },
  { value: "credit_note", label: "Nota de crédito" },
];

function emptyLine(): SalesLineInput {
  return { description: "", amount: "" };
}

export function EditSalesDocumentForm({
  companyId,
  document,
  clients,
  projects,
  currentUserId,
  currentUserEmail,
}: {
  companyId: string;
  document: SalesDocumentWithLines;
  clients: Client[];
  projects: ProjectWithRelations[];
  currentUserId: string | null;
  currentUserEmail: string | null;
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
      project_id: document.project_id ?? "",
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

  const isEdited = document.updated_at !== document.created_at;

  return (
    <div className="flex flex-col gap-5">
      {isEdited ? <Badge variant="warning" className="w-fit">Editado</Badge> : null}

      <Card padding="0">
        <form
          action={formAction}
          onSubmit={handleSubmit}
          className="flex flex-col gap-5 p-6"
        >
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="client_id" className={fieldLabel}>
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
                className={fieldInput}
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
              <label htmlFor="project_id" className={fieldLabel}>
                Proyecto
              </label>
              <select
                id="project_id"
                name="project_id"
                value={selectedProjectId}
                onChange={(event) => setSelectedProjectId(event.target.value)}
                disabled={!selectedClientId}
                className={fieldInput}
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
              <label htmlFor="document_type" className={fieldLabel}>
                Tipo
              </label>
              <select
                id="document_type"
                name="document_type"
                required
                defaultValue={state.values.document_type}
                className={fieldInput}
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
                <label htmlFor="document_date" className={fieldLabel}>
                  Fecha
                </label>
                <input
                  id="document_date"
                  name="document_date"
                  type="date"
                  required
                  defaultValue={state.values.document_date}
                  className={`${fieldInput} font-mono`}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="currency" className={fieldLabel}>
                  Moneda
                </label>
                <input
                  id="currency"
                  name="currency"
                  type="text"
                  required
                  defaultValue={state.values.currency}
                  className={`${fieldInput} font-mono`}
                />
              </div>
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
                    className="px-1 text-[13px] text-[#c0c4c9] hover:text-[var(--color-negative-ink)] disabled:opacity-40"
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
                  className="w-28 rounded-[7px] border border-[var(--color-hairline)] bg-white px-2 py-1.5 text-right font-mono text-[13px] outline-none focus:border-[var(--color-ink)]"
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

          <FormActions cancelHref={`/companies/${companyId}/sales`} pending={pending}>
            Guardar cambios
          </FormActions>
        </form>
      </Card>

      <ReassignPeriodSection
        companyId={companyId}
        salesDocumentId={document.id}
        recognizedPeriod={document.recognized_period}
        recognizedPeriodSetBy={document.recognized_period_set_by}
        recognizedPeriodSetAt={document.recognized_period_set_at}
        currentUserId={currentUserId}
        currentUserEmail={currentUserEmail}
      />

      <VoidDocumentSection companyId={companyId} salesDocumentId={document.id} />
    </div>
  );
}

/**
 * Story 6.6: "Reassign period" form + audit note, shared shape with
 * the cost document detail page's own version. There's no
 * user-id-to-display-name resolution anywhere in this codebase yet
 * (created_by/updated_by/voided_by are all stored but never shown) --
 * building one is out of scope for this narrow story, so the note
 * shows the setter's own email only when it's the viewer themself
 * (the common case right after reassigning) and falls back to "another
 * user" otherwise, rather than a bare, meaningless uuid.
 */
function ReassignPeriodSection({
  companyId,
  salesDocumentId,
  recognizedPeriod,
  recognizedPeriodSetBy,
  recognizedPeriodSetAt,
  currentUserId,
  currentUserEmail,
}: {
  companyId: string;
  salesDocumentId: string;
  recognizedPeriod: string | null;
  recognizedPeriodSetBy: string | null;
  recognizedPeriodSetAt: string | null;
  currentUserId: string | null;
  currentUserEmail: string | null;
}) {
  const reassignWithIds = reassignSalesDocumentPeriod.bind(
    null,
    companyId,
    salesDocumentId,
  );

  const initialState: ReassignPeriodState = { error: null };
  const [state, formAction, pending] = useActionState(
    reassignWithIds,
    initialState,
  );

  const setterLabel =
    recognizedPeriodSetBy && currentUserId === recognizedPeriodSetBy
      ? (currentUserEmail ?? "vos")
      : "otro usuario";

  return (
    <Card className="flex flex-col gap-2">
      <h2 className="text-[13px] font-semibold text-[var(--color-ink)]">
        Período reconocido
      </h2>
      <p className="text-[12.5px] text-[var(--color-muted)]">
        Por defecto este documento se reconoce en el mes de su fecha para
        todos los reportes. Reasigná acá si su ingreso debe reconocerse en
        otro mes (ej. un proyecto multi-mes) -- esto nunca cambia la fecha
        del documento ni ningún importe.
      </p>

      {recognizedPeriod && recognizedPeriodSetAt ? (
        <p className="text-[12.5px] text-[var(--color-ink-2)]">
          Reconocido en {formatPeriod(recognizedPeriod)}, reasignado por{" "}
          {setterLabel} el{" "}
          {new Date(recognizedPeriodSetAt).toLocaleDateString("es-UY")}.
        </p>
      ) : (
        <p className="text-[12.5px] text-[var(--color-muted)]">
          Sin reasignar -- reconocido en el mes de su fecha.
        </p>
      )}

      <form action={formAction} className="flex items-end gap-2">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="recognized_period" className={fieldLabel}>
            Reconocer en mes
          </label>
          <input
            id="recognized_period"
            name="recognized_period"
            type="month"
            required
            defaultValue={recognizedPeriod ? recognizedPeriod.slice(0, 7) : ""}
            className={`${fieldInput} font-mono`}
          />
        </div>
        <Button type="submit" variant="secondary" pending={pending} pendingLabel="Reasignando…">
          Reasignar
        </Button>
      </form>

      {state.error ? (
        <p className="text-[13px] text-[var(--color-negative-ink)]" role="alert">
          {state.error}
        </p>
      ) : null}
    </Card>
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
    <div className="flex flex-col gap-2 rounded-[10px] border border-[var(--color-negative-soft)] bg-[var(--color-negative-soft)]/20 p-4">
      <p className="text-[12.5px] text-[var(--color-ink-2)]">
        Anular saca este documento de uso activo sin borrarlo -- sigue visible
        en la lista con la etiqueta &quot;Anulado&quot; y ya no puede editarse.
      </p>

      {state.error ? (
        <p className="text-[13px] text-[var(--color-negative-ink)]" role="alert">
          {state.error}
        </p>
      ) : null}

      {confirming ? (
        <form action={formAction} className="flex items-center gap-3">
          <p className="text-[13px] font-medium text-[var(--color-negative-ink)]">
            ¿Estás seguro? Esto no se puede deshacer.
          </p>
          <button
            type="submit"
            disabled={pending}
            className="rounded-lg bg-[var(--color-negative)] px-4 py-1.5 text-[13px] font-medium text-white disabled:opacity-60"
          >
            {pending ? "Anulando…" : "Sí, anular"}
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            className="text-[13px] text-[var(--color-muted)] hover:text-[var(--color-ink)]"
          >
            Cancelar
          </button>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="w-fit rounded-lg border border-[var(--color-negative-soft)] px-4 py-1.5 text-[13px] font-medium text-[var(--color-negative-ink)] hover:bg-[var(--color-negative-soft)]"
        >
          Anular este documento
        </button>
      )}
    </div>
  );
}
