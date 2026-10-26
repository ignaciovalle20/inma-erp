"use client";

import Link from "next/link";
import { startTransition, useActionState, useState } from "react";
import type {
  BusinessArea,
  Client,
  CostDocument,
  ProjectWithRelations,
} from "@/lib/dal";
import type { ServicePeriodOption } from "@/lib/costServiceAllocations";
import { formatPeriod } from "@/lib/period";
import {
  derivedPercentage,
  fillRemainder,
  fromMinor,
  resolveAmounts,
  resolvedTotals,
  splitEvenly,
  toMinor,
} from "@/lib/allocations";
import { AllocationBar, allocationColor } from "@/components/AllocationBar";
import { Card } from "@/components/Card";
import { Money, formatAmount } from "@/components/Money";
import { AmountInput } from "@/components/AmountInput";
import { currencyDecimals } from "@/lib/currencies";
import { Button } from "@/components/Button";
import { MsPoolCoverageWarning } from "@/components/MsPoolCoverageWarning";
import { attributedAreaIds, findCoveringPool, type MsLicensePool } from "@/lib/msLicensePool";
import {
  setCostAllocations,
  type AllocationRowInput,
  type AllocationTargetType,
  type SetCostAllocationsState,
} from "./actions";

const TARGET_TYPE_OPTIONS: { value: AllocationTargetType; label: string }[] = [
  { value: "project", label: "Proyecto" },
  { value: "client", label: "Cliente" },
  { value: "business_area", label: "Área" },
  { value: "service", label: "Servicio" },
];

function serviceLabel(option: ServicePeriodOption): string {
  const client = option.clientName ? ` · ${option.clientName}` : "";
  return `${option.serviceName}${client} · ${formatPeriod(option.period)}`;
}

const CHIP_CLASSES = {
  idle: "border border-[var(--color-hairline)] bg-[var(--color-surface)] text-[var(--color-ink-2)] hover:border-[var(--color-border-hover)]",
  active: "border border-[var(--color-accent-soft-border)] bg-[var(--color-accent-soft)] text-[var(--color-accent-strong)]",
};

function emptyRow(): AllocationRowInput {
  return { target_type: "", target_id: "", method: "percentage", value: "" };
}

function isRowInvalid(row: AllocationRowInput): boolean {
  const value = Number(row.value);
  return (
    !row.target_type ||
    !row.target_id ||
    row.value.trim() === "" ||
    !Number.isFinite(value) ||
    value < 0
  );
}

export function CostAllocationForm({
  companyId,
  document,
  initialRows: savedRows,
  serviceOptions,
  projects,
  clients,
  businessAreas,
  msLicenseCoverage,
  projectAreaById,
}: {
  companyId: string;
  document: CostDocument;
  /** The saved rows of both kinds, in order (empty when nothing is saved). */
  initialRows: AllocationRowInput[];
  /** Recurring service cost periods this document can go to (none: no "Servicio" type). */
  serviceOptions: ServicePeriodOption[];
  projects: ProjectWithRelations[];
  clients: Client[];
  businessAreas: BusinessArea[];
  /** MS licenses pools and areas, to warn while the document would be "cubierto por pool". */
  msLicenseCoverage: { pools: MsLicensePool[]; msLicenseAreaIds: string[]; failed: boolean };
  /** Area of every job of the company (closed ones too: an existing row may point at one). */
  projectAreaById: Record<string, string>;
}) {
  const setCostAllocationsWithIds = setCostAllocations.bind(
    null,
    companyId,
    document.id,
  );

  // Always at least the 2 rows a split needs (one saved service row + one empty).
  const initialRows: AllocationRowInput[] = [
    ...savedRows,
    ...Array.from({ length: Math.max(0, 2 - savedRows.length) }, emptyRow),
  ];

  const initialState: SetCostAllocationsState = {
    error: null,
    success: false,
    values: { rows: initialRows },
  };

  const [state, formAction, pending] = useActionState(
    setCostAllocationsWithIds,
    initialState,
  );

  const [rows, setRows] = useState<AllocationRowInput[]>(
    state.values.rows.length > 0 ? state.values.rows : [emptyRow(), emptyRow()],
  );
  // Row the user last focused: "Completar el faltante" fills it, and it is
  // the one flagged when an amount pushes the set over the total.
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  const total = document.total_amount;
  const decimals = currencyDecimals(document.currency);

  function updateRow(index: number, patch: Partial<AllocationRowInput>) {
    setRows((prev) =>
      prev.map((row, i) => {
        if (i !== index) return row;
        const next = { ...row, ...patch };
        if (patch.target_type !== undefined && patch.target_type !== row.target_type) {
          next.target_id = "";
        }
        return next;
      }),
    );
  }

  function addRow() {
    setRows((prev) => [...prev, emptyRow()]);
  }

  function removeRow(index: number) {
    if (rows.length <= 2) return;
    setRows((prev) => prev.filter((_, i) => i !== index));
    setActiveIndex(null);
  }

  function fillTarget(): number {
    if (activeIndex !== null && activeIndex < rows.length) return activeIndex;
    const lastEmpty = rows.findLastIndex((row) => row.value.trim() === "");
    return lastEmpty !== -1 ? lastEmpty : rows.length - 1;
  }

  function pickerOptions(targetType: AllocationTargetType | "") {
    if (targetType === "service") {
      return serviceOptions.map((option) => ({ id: option.id, name: serviceLabel(option) }));
    }
    if (targetType === "project") {
      return projects.map((project) => ({ id: project.id, name: project.name }));
    }
    if (targetType === "client") {
      return clients.map((client) => ({ id: client.id, name: client.name }));
    }
    if (targetType === "business_area") {
      return businessAreas.map((area) => ({ id: area.id, name: area.name }));
    }
    return [];
  }

  // Whole minor units per row (pesos for CLP): what the bar, the totals and
  // the save all use, rounding residue of percentage rows already settled.
  const amounts = resolveAmounts(rows, total, decimals);
  const totals = resolvedTotals(rows, total, decimals);
  const hasIncompleteRow = rows.some(isRowInvalid);
  const hasEnoughRows = rows.length >= 2;
  // A service period takes one row: the database keeps one allocation per period.
  const repeatedService = (index: number) =>
    rows[index].target_type === "service" &&
    rows[index].target_id !== "" &&
    rows.some((row, i) => i < index && row.target_type === "service" && row.target_id === rows[index].target_id);
  const hasRepeatedService = rows.some((_, index) => repeatedService(index));
  const canSubmit = totals.matches && !hasIncompleteRow && hasEnoughRows && !hasRepeatedService;
  // The "Servicio" type: offered when there are periods, kept on rows already saved with it.
  const targetTypeOptions = TARGET_TYPE_OPTIONS.filter(
    (option) => option.value !== "service" || serviceOptions.length > 0 || rows.some((row) => row.target_type === "service"),
  );
  /** What a service row's part of the total (IVA included) leaves to the service: its net. */
  const serviceNet = (amountMinor: number) =>
    total > 0 ? fromMinor(Math.round((amountMinor * document.net_amount) / total), decimals) : 0;
  const gap = formatAmount(fromMinor(Math.abs(totals.missing), decimals), document.currency);

  // The row whose amount pushed the set over the total.
  const overIndex = !totals.over
    ? -1
    : activeIndex !== null && activeIndex < rows.length && rows[activeIndex].value.trim() !== ""
      ? activeIndex
      : rows.findLastIndex((row) => row.value.trim() !== "");

  const totalMinor = toMinor(total, decimals);
  const segments = rows.map((row, index) => ({
    label:
      pickerOptions(row.target_type).find((option) => option.id === row.target_id)?.name ??
      "",
    share: totalMinor > 0 ? amounts[index] / totalMinor : 0,
    color: allocationColor(index).color,
  }));

  // Point 5: the destinations chosen here can put the document in the MS
  // licenses area (or outside it) -- same rule as covered_by_cost_pool_id,
  // on the document's effective month.
  const chosen = (type: AllocationTargetType) =>
    rows.filter((row) => row.target_type === type && row.target_id).map((row) => row.target_id);
  const coveringPool = findCoveringPool(
    {
      date: document.recognized_period ?? document.document_date,
      supplierId: document.supplier_id,
      areaIds: attributedAreaIds(
        { projectIds: chosen("project"), areaIds: chosen("business_area") },
        projectAreaById,
      ),
    },
    msLicenseCoverage.pools,
    msLicenseCoverage.msLicenseAreaIds,
  );

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between">
          <div className="flex flex-col gap-1">
            <span className="caps-label text-[var(--color-muted)]">
              Por repartir
            </span>
            <Money
              value={total}
              currency={document.currency}
              className="text-[22px] font-semibold text-[var(--color-ink)]"
            />
          </div>
          <div className="flex flex-col items-end gap-1">
            <span className="caps-label text-[var(--color-muted)]">
              {totals.over ? "Te pasaste" : "Falta"}
            </span>
            <Money
              value={fromMinor(Math.abs(totals.missing), decimals)}
              currency={document.currency}
              showCurrency={false}
              className={`text-[16px] font-semibold ${
                totals.matches
                  ? "text-[var(--color-accent-strong)]"
                  : totals.over
                    ? "text-[var(--color-negative-ink)]"
                    : "text-[var(--color-warning-ink)]"
              }`}
            />
          </div>
        </div>
        <AllocationBar segments={segments} />
      </Card>

      <form
        action={formAction}
        // Dispatched by hand, not through the form's action: React resets a
        // form after its action finishes, which put every (controlled)
        // destination <select> back on its first option in the DOM while the
        // state still held the saved rows -- every row then showed the first
        // destination of the list until the page was reloaded.
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          startTransition(() => formAction(data));
        }}
        className="flex flex-col gap-3"
      >
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => setRows((prev) => splitEvenly(prev, total, decimals))}
            className={`rounded-lg px-3 py-1.5 text-[12.5px] font-medium ${CHIP_CLASSES.idle}`}
          >
            Partes iguales
          </button>
          <button
            type="button"
            onClick={() => {
              const index = fillTarget();
              setRows((prev) => fillRemainder(prev, index, total, decimals));
            }}
            className={`rounded-lg px-3 py-1.5 text-[12.5px] font-medium ${CHIP_CLASSES.idle}`}
          >
            Completar el faltante
          </button>
        </div>

        <Card padding="0" className="overflow-hidden">
          <div
            className="hidden border-b border-[var(--color-hairline-soft)] px-3 py-2 caps-label text-[var(--color-muted)] sm:grid sm:grid-cols-[96px_minmax(0,1fr)_92px_112px_28px] sm:gap-2"
          >
            <span>Tipo</span>
            <span>Destino</span>
            <span>Porcentaje</span>
            <span>Importe</span>
            <span />
          </div>

          <div className="flex flex-col">
            {rows.map((row, index) => {
              // The field typed last keeps what the user wrote; the other
              // one is derived from it here, on every render.
              const blank = row.value.trim() === "";
              const amount = String(fromMinor(amounts[index], decimals));
              const percentageValue =
                row.method === "percentage" || blank
                  ? row.value
                  : derivedPercentage(amounts[index], total, decimals);
              const amountValue = row.method === "fixed_amount" || blank ? row.value : amount;
              const repeated = repeatedService(index);
              const invalid = isRowInvalid(row) || repeated;
              const over = index === overIndex;

              return (
                <div
                  key={index}
                  onFocus={() => setActiveIndex(index)}
                  aria-invalid={over || undefined}
                  className={`flex flex-col gap-2 border-b border-[var(--color-hairline-soft)] p-3 last:border-b-0 sm:grid sm:grid-cols-[96px_minmax(0,1fr)_92px_112px_28px] sm:items-center sm:gap-2 sm:py-2 ${
                    over
                      ? "bg-[var(--color-negative-row)]"
                      : invalid
                        ? "bg-[var(--color-warning-row)]"
                        : ""
                  }`}
                >
                  <div className="flex flex-col gap-1">
                    <label className="caps-label text-[var(--color-muted)] sm:hidden">
                      Tipo
                    </label>
                    <select
                      name="target_type"
                      value={row.target_type}
                      onChange={(event) =>
                        updateRow(index, {
                          target_type: event.target.value as AllocationTargetType,
                        })
                      }
                      className="rounded-lg border border-[var(--color-hairline)] bg-[var(--color-surface)] px-2 py-[7px] text-[12.5px] text-[var(--color-ink)] outline-none focus:border-[var(--color-ink)]"
                    >
                      <option value="" disabled>
                        Elegí
                      </option>
                      {targetTypeOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="flex flex-col gap-1">
                    <label className="caps-label text-[var(--color-muted)] sm:hidden">
                      Destino
                    </label>
                    <select
                      name="target_id"
                      value={row.target_id}
                      disabled={!row.target_type}
                      onChange={(event) => updateRow(index, { target_id: event.target.value })}
                      className="w-full rounded-lg border border-[var(--color-hairline)] bg-[var(--color-surface)] px-2 py-[7px] text-[12.5px] text-[var(--color-ink)] outline-none focus:border-[var(--color-ink)] disabled:opacity-40"
                    >
                      <option value="" disabled>
                        Elegí un destino
                      </option>
                      {pickerOptions(row.target_type).map((option) => (
                        <option key={option.id} value={option.id}>
                          {option.name}
                        </option>
                      ))}
                    </select>
                    {repeated ? (
                      <span className="text-[11.5px] text-[var(--color-warning-ink)]">
                        Este servicio y período ya está en otra fila.
                      </span>
                    ) : row.target_type === "service" && !blank ? (
                      <span className="text-[11.5px] text-[var(--color-muted)]">
                        Neto al servicio: {formatAmount(serviceNet(amounts[index]), document.currency)}{" "}
                        {document.currency}
                      </span>
                    ) : null}
                  </div>

                  <div className="flex flex-col gap-1">
                    <label className="caps-label text-[var(--color-muted)] sm:hidden">
                      Porcentaje
                    </label>
                    <AmountInput
                      aria-label="Porcentaje"
                      grouping={false}
                      padDecimals={row.method !== "percentage"}
                      value={percentageValue}
                      onValueChange={(value) => updateRow(index, { method: "percentage", value })}
                      className={`rounded-lg border border-[var(--color-hairline)] bg-[var(--color-surface)] px-2 py-[7px] text-right font-mono text-[12.5px] outline-none focus:border-[var(--color-ink)] ${
                        row.method === "percentage" ? "text-[var(--color-ink)]" : "text-[var(--color-muted)]"
                      }`}
                    />
                  </div>

                  <div className="flex flex-col gap-1">
                    <label className="caps-label text-[var(--color-muted)] sm:hidden">
                      Importe
                    </label>
                    <AmountInput
                      aria-label="Importe"
                      maxDecimals={decimals}
                      value={amountValue}
                      onValueChange={(value) => updateRow(index, { method: "fixed_amount", value })}
                      className={`rounded-lg border bg-[var(--color-surface)] px-2 py-[7px] text-right font-mono text-[12.5px] outline-none ${
                        over
                          ? "border-[var(--color-negative-ink)] focus:border-[var(--color-negative-ink)]"
                          : "border-[var(--color-hairline)] focus:border-[var(--color-ink)]"
                      } ${row.method === "fixed_amount" ? "text-[var(--color-ink)]" : "text-[var(--color-muted)]"}`}
                    />
                  </div>

                  {/* The amount is what is saved; the percentage is derived from it. */}
                  <input type="hidden" name="method" value="fixed_amount" />
                  <input type="hidden" name="value" value={blank ? "" : amount} />

                  <button
                    type="button"
                    onClick={() => removeRow(index)}
                    disabled={rows.length <= 2}
                    aria-label="Quitar destino"
                    className="h-7 w-7 shrink-0 self-end rounded-md text-[13px] text-[var(--color-muted)] hover:bg-[var(--color-row)] hover:text-[var(--color-negative-ink)] disabled:opacity-40 sm:self-center"
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--color-hairline-soft)] bg-[var(--color-surface-muted)] px-4 py-3">
            <button
              type="button"
              onClick={addRow}
              className="text-[13px] font-medium text-[var(--color-accent-strong)]"
            >
              + Agregar destino
            </button>
            <div className="flex items-center gap-3 text-[12.5px]">
              <span
                className={
                  totals.over
                    ? "text-[var(--color-negative-ink)]"
                    : !hasEnoughRows || !totals.matches
                      ? "text-[var(--color-warning-ink)]"
                      : "text-[var(--color-accent-strong)]"
                }
              >
                {!hasEnoughRows
                  ? "Se necesitan al menos 2 destinos."
                  : totals.matches
                    ? "Asignado completo"
                    : totals.over
                      ? `Te pasaste por ${gap} ${document.currency}`
                      : `Falta ${gap} ${document.currency}`}
              </span>
              <span className="font-mono text-[13px] font-semibold text-[var(--color-ink)]">
                {formatAmount(fromMinor(totals.assigned, decimals), document.currency)} /{" "}
                {formatAmount(total, document.currency)}
              </span>
            </div>
          </div>
        </Card>

        <MsPoolCoverageWarning
          companyId={companyId}
          pool={coveringPool}
          failed={msLicenseCoverage.failed}
        />

        {state.error ? (
          <p className="text-[13px] text-[var(--color-negative-ink)]" role="alert">
            {state.error}
          </p>
        ) : null}

        {state.success ? (
          <p className="text-[13px] text-[var(--color-accent-strong)]" role="status">
            Asignación guardada.
          </p>
        ) : null}

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-3">
            <Button
              type="submit"
              pending={pending}
              pendingLabel="Guardando…"
              disabled={!canSubmit}
              className="flex-1"
            >
              Guardar asignación
            </Button>
            <Link
              href={`/companies/${companyId}/costs`}
              className="text-[13px] text-[var(--color-muted)] hover:text-[var(--color-ink)]"
            >
              Volver
            </Link>
          </div>
          <p className="text-[11.5px] text-[var(--color-muted)]">
            El botón se habilita cuando el reparto cuadra con el total.
            {rows.some((row) => row.target_type === "service")
              ? " Los importes van con IVA, como el total; cada servicio registra su neto como costo."
              : ""}
          </p>
        </div>
      </form>
    </div>
  );
}
