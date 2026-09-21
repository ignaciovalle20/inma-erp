"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import type {
  BusinessArea,
  Client,
  CostAllocationMethod,
  CostAllocationTargetType,
  CostAllocationWithTargetName,
  CostDocument,
  ProjectWithRelations,
} from "@/lib/dal";
import {
  allocationTotals,
  fillRemainder,
  rowShare,
  splitEvenly,
  toFixedAmount,
  toPercentage,
} from "@/lib/allocations";
import { AllocationBar, allocationColor } from "@/components/AllocationBar";
import { Card } from "@/components/Card";
import { Money, formatAmount, formatDecimal } from "@/components/Money";
import { AmountInput } from "@/components/AmountInput";
import { currencyDecimals } from "@/lib/currencies";
import { Button } from "@/components/Button";
import {
  setCostAllocations,
  type AllocationRowInput,
  type SetCostAllocationsState,
} from "./actions";

const TARGET_TYPE_OPTIONS: { value: CostAllocationTargetType; label: string }[] = [
  { value: "project", label: "Proyecto" },
  { value: "client", label: "Cliente" },
  { value: "business_area", label: "Área" },
];

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
  allocations,
  projects,
  clients,
  businessAreas,
}: {
  companyId: string;
  document: CostDocument;
  allocations: CostAllocationWithTargetName[];
  projects: ProjectWithRelations[];
  clients: Client[];
  businessAreas: BusinessArea[];
}) {
  const setCostAllocationsWithIds = setCostAllocations.bind(
    null,
    companyId,
    document.id,
  );

  const initialRows: AllocationRowInput[] =
    allocations.length > 0
      ? allocations.map((allocation) => ({
          target_type: allocation.target_type,
          target_id: allocation.target_id,
          method: allocation.method,
          value: String(
            allocation.method === "percentage"
              ? allocation.percentage
              : allocation.amount,
          ),
        }))
      : [emptyRow(), emptyRow()];

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
  // Tracks which side of the % / importe toggle is currently active, for
  // the chip's highlighted state -- purely cosmetic, doesn't gate anything.
  const [viewMethod, setViewMethod] = useState<CostAllocationMethod>("percentage");

  const total = document.total_amount;

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
    setRows((prev) =>
      prev.length > 2 ? prev.filter((_, i) => i !== index) : prev,
    );
  }

  function pickerOptions(targetType: CostAllocationTargetType | "") {
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

  const totals = allocationTotals(rows, total);
  const hasIncompleteRow = rows.some(isRowInvalid);
  const hasEnoughRows = rows.length >= 2;
  const canSubmit = totals.matches && !hasIncompleteRow && hasEnoughRows;

  const segments = rows.map((row, index) => ({
    label:
      pickerOptions(row.target_type).find((option) => option.id === row.target_id)?.name ??
      "",
    share: total > 0 ? rowShare(row, total) / total : 0,
    color: allocationColor(index).color,
  }));

  const missingPct = total > 0 ? Math.abs((totals.missing / total) * 100) : 0;

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between">
          <div className="flex flex-col gap-1">
            <span className="font-mono text-[10px] uppercase tracking-[0.13em] text-[var(--color-muted)]">
              Por repartir
            </span>
            <Money
              value={total}
              currency={document.currency}
              className="text-[22px] font-semibold text-[var(--color-ink)]"
            />
          </div>
          <div className="flex flex-col items-end gap-1">
            <span className="font-mono text-[10px] uppercase tracking-[0.13em] text-[var(--color-muted)]">
              Falta
            </span>
            <Money
              value={totals.missing}
              currency={document.currency}
              showCurrency={false}
              className={`text-[16px] font-semibold ${
                totals.matches
                  ? "text-[var(--color-accent-strong)]"
                  : "text-[var(--color-warning-ink)]"
              }`}
            />
          </div>
        </div>
        <AllocationBar segments={segments} />
      </Card>

      <form action={formAction} className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => setRows((prev) => splitEvenly(prev))}
            className={`rounded-lg px-3 py-1.5 text-[12.5px] font-medium ${CHIP_CLASSES.idle}`}
          >
            Partes iguales
          </button>
          <button
            type="button"
            onClick={() =>
              setRows((prev) => fillRemainder(prev, prev.length - 1, total, currencyDecimals(document.currency)))
            }
            className={`rounded-lg px-3 py-1.5 text-[12.5px] font-medium ${CHIP_CLASSES.idle}`}
          >
            Completar el faltante
          </button>
          <button
            type="button"
            onClick={() => {
              const next = viewMethod === "percentage" ? "fixed_amount" : "percentage";
              setRows((prev) =>
                next === "fixed_amount"
                  ? toFixedAmount(prev, total, currencyDecimals(document.currency))
                  : toPercentage(prev, total),
              );
              setViewMethod(next);
            }}
            className={`rounded-lg px-3 py-1.5 text-[12.5px] font-medium ${
              viewMethod === "fixed_amount" ? CHIP_CLASSES.active : CHIP_CLASSES.idle
            }`}
          >
            % ↔ importe
          </button>
        </div>

        <Card padding="0" className="overflow-hidden">
          <div
            className="hidden border-b border-[var(--color-hairline-soft)] px-3 py-2 font-mono text-[9.5px] font-medium uppercase tracking-[0.12em] text-[var(--color-muted)] sm:grid sm:grid-cols-[96px_minmax(0,1fr)_92px_112px_28px] sm:gap-2"
          >
            <span>Tipo</span>
            <span>Destino</span>
            <span>Porcentaje</span>
            <span>Importe</span>
            <span />
          </div>

          <div className="flex flex-col">
            {rows.map((row, index) => {
              const share = rowShare(row, total);
              const pctDerived = formatDecimal(total > 0 ? (share / total) * 100 : 0, 2);
              const amountDerived = formatAmount(share, document.currency);
              const invalid = isRowInvalid(row);

              return (
                <div
                  key={index}
                  className={`flex flex-col gap-2 border-b border-[var(--color-hairline-soft)] p-3 last:border-b-0 sm:grid sm:grid-cols-[96px_minmax(0,1fr)_92px_112px_28px] sm:items-center sm:gap-2 sm:py-2 ${
                    invalid ? "bg-[var(--color-warning-row)]" : ""
                  }`}
                >
                  <div className="flex flex-col gap-1">
                    <label className="font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--color-muted)] sm:hidden">
                      Tipo
                    </label>
                    <select
                      name="target_type"
                      value={row.target_type}
                      onChange={(event) =>
                        updateRow(index, {
                          target_type: event.target.value as CostAllocationTargetType,
                        })
                      }
                      className="rounded-lg border border-[var(--color-hairline)] bg-[var(--color-surface)] px-2 py-[7px] text-[12.5px] text-[var(--color-ink)] outline-none focus:border-[var(--color-ink)]"
                    >
                      <option value="" disabled>
                        Elegí
                      </option>
                      {TARGET_TYPE_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="flex flex-col gap-1">
                    <label className="font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--color-muted)] sm:hidden">
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
                  </div>

                  <div className="flex flex-col gap-1">
                    <label className="font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--color-muted)] sm:hidden">
                      Porcentaje
                    </label>
                    {row.method === "percentage" ? (
                      <AmountInput
                        name="value"
                        grouping={false}
                        value={row.value}
                        onValueChange={(value) => updateRow(index, { value })}
                        className="rounded-lg border border-[var(--color-hairline)] bg-[var(--color-surface)] px-2 py-[7px] text-right font-mono text-[12.5px] text-[var(--color-ink)] outline-none focus:border-[var(--color-ink)]"
                      />
                    ) : (
                      <input
                        readOnly
                        tabIndex={-1}
                        value={pctDerived}
                        className="rounded-lg border border-[var(--color-hairline)] bg-[var(--color-surface-muted)] px-2 py-[7px] text-right font-mono text-[12.5px] text-[var(--color-muted)]"
                      />
                    )}
                  </div>

                  <div className="flex flex-col gap-1">
                    <label className="font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--color-muted)] sm:hidden">
                      Importe
                    </label>
                    {row.method === "fixed_amount" ? (
                      <AmountInput
                        name="value"
                        maxDecimals={currencyDecimals(document.currency)}
                        value={row.value}
                        onValueChange={(value) => updateRow(index, { value })}
                        className="rounded-lg border border-[var(--color-hairline)] bg-[var(--color-surface)] px-2 py-[7px] text-right font-mono text-[12.5px] text-[var(--color-ink)] outline-none focus:border-[var(--color-ink)]"
                      />
                    ) : (
                      <input
                        readOnly
                        tabIndex={-1}
                        value={amountDerived}
                        className="rounded-lg border border-[var(--color-hairline)] bg-[var(--color-surface-muted)] px-2 py-[7px] text-right font-mono text-[12.5px] text-[var(--color-muted)]"
                      />
                    )}
                  </div>

                  <input type="hidden" name="method" value={row.method} />

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
                  !hasEnoughRows || !totals.matches
                    ? "text-[var(--color-warning-ink)]"
                    : "text-[var(--color-accent-strong)]"
                }
              >
                {!hasEnoughRows
                  ? "Se necesitan al menos 2 destinos."
                  : totals.matches
                    ? "Asignado completo"
                    : `Falta ${missingPct.toFixed(0)}% para llegar al total`}
              </span>
              <span className="font-mono text-[13px] font-semibold text-[var(--color-ink)]">
                {formatAmount(totals.assigned, document.currency)} /{" "}
                {formatAmount(total, document.currency)}
              </span>
            </div>
          </div>
        </Card>

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
          </p>
        </div>
      </form>
    </div>
  );
}
