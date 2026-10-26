"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { Card } from "@/components/Card";
import { Money, formatAmount } from "@/components/Money";
import { AmountInput } from "@/components/AmountInput";
import { Button } from "@/components/Button";
import { currencyDecimals } from "@/lib/currencies";
import { formatPeriod } from "@/lib/period";
import type { ServicePeriodOption } from "@/lib/costServiceAllocations";
import {
  setServiceAllocations,
  type ServiceAllocationRowInput,
  type SetServiceAllocationsState,
} from "./actions";


const inputClass =
  "w-full rounded-lg border border-[var(--color-hairline)] bg-[var(--color-surface)] px-2 py-[7px] text-[12.5px] text-[var(--color-ink)] outline-none focus:border-[var(--color-ink)]";

function optionLabel(option: ServicePeriodOption): string {
  const client = option.clientName ? ` · ${option.clientName}` : "";
  return `${option.serviceName}${client} · ${formatPeriod(option.period)} · esperado ${formatAmount(option.expected, option.currency)} ${option.currency}`;
}

export function ServiceAllocationForm({
  companyId,
  documentId,
  netAmount,
  currency,
  options,
  initialRows,
}: {
  companyId: string;
  documentId: string;
  netAmount: number;
  currency: string;
  options: ServicePeriodOption[];
  initialRows: ServiceAllocationRowInput[];
}) {
  const action = setServiceAllocations.bind(null, companyId, documentId);
  const initialState: SetServiceAllocationsState = { error: null, success: false, values: { rows: initialRows } };
  const [state, formAction, pending] = useActionState(action, initialState);
  const [rows, setRows] = useState<ServiceAllocationRowInput[]>(state.values.rows);

  const decimals = currencyDecimals(currency);
  const tolerance = decimals === 0 ? 0.5 : 0.005;
  const assigned = rows.reduce((sum, row) => sum + (Number(row.amount) || 0), 0);
  const left = netAmount - assigned;
  const overAssigned = left < -tolerance;
  const incomplete = rows.some((row) => !row.cost_period_id || !(Number(row.amount) > 0));
  const optionById = new Map(options.map((option) => [option.id, option]));
  const otherCurrency = rows.some((row) => {
    const option = optionById.get(row.cost_period_id);
    return option && option.currency !== currency;
  });

  function updateRow(index: number, patch: Partial<ServiceAllocationRowInput>) {
    setRows((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  const sameSupplier = options.filter((option) => option.sameSupplier);
  const others = options.filter((option) => !option.sameSupplier);

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex items-baseline justify-between gap-3">
        <div className="flex flex-col gap-1">
          <span className="caps-label text-[var(--color-muted)]">Neto de la factura</span>
          <Money value={netAmount} currency={currency} className="text-[22px] font-semibold text-[var(--color-ink)]" />
        </div>
        <div className="flex flex-col items-end gap-1">
          <span className="caps-label text-[var(--color-muted)]">Sin asignar a servicios</span>
          <Money
            value={left}
            currency={currency}
            showCurrency={false}
            className={`text-[16px] font-semibold ${overAssigned ? "text-[var(--color-negative-ink)]" : "text-[var(--color-ink)]"}`}
          />
        </div>
      </Card>

      <form action={formAction} className="flex flex-col gap-3">
        <Card padding="0" className="overflow-hidden">
          {rows.length === 0 ? (
            <p className="px-4 py-3 text-[12.5px] text-[var(--color-muted)]">
              Sin servicios: al guardar, la factura queda como costo general sin asignar.
            </p>
          ) : null}
          {rows.map((row, index) => (
            <div
              key={index}
              className="flex flex-col gap-2 border-b border-[var(--color-hairline-soft)] p-3 sm:grid sm:grid-cols-[minmax(0,1fr)_130px_28px] sm:items-center"
            >
              <select
                name="cost_period_id"
                aria-label="Servicio y período"
                value={row.cost_period_id}
                onChange={(event) => updateRow(index, { cost_period_id: event.target.value })}
                className={inputClass}
              >
                <option value="" disabled>
                  Elegí un servicio y período
                </option>
                {sameSupplier.length > 0 ? (
                  <optgroup label="Servicios de este proveedor">
                    {sameSupplier.map((option) => (
                      <option key={option.id} value={option.id}>
                        {optionLabel(option)}
                      </option>
                    ))}
                  </optgroup>
                ) : null}
                {others.length > 0 ? (
                  <optgroup label="Otros servicios">
                    {others.map((option) => (
                      <option key={option.id} value={option.id}>
                        {optionLabel(option)}
                      </option>
                    ))}
                  </optgroup>
                ) : null}
              </select>
              <AmountInput
                name="amount"
                aria-label="Monto"
                maxDecimals={decimals}
                value={row.amount}
                onValueChange={(value) => updateRow(index, { amount: value })}
                className={`${inputClass} text-right font-mono`}
              />
              <button
                type="button"
                onClick={() => setRows((prev) => prev.filter((_, i) => i !== index))}
                aria-label="Quitar servicio"
                className="h-7 w-7 shrink-0 self-end rounded-md text-[13px] text-[var(--color-muted)] hover:bg-[var(--color-row)] hover:text-[var(--color-negative-ink)] sm:self-center"
              >
                ×
              </button>
            </div>
          ))}
          <div className="flex flex-wrap items-center justify-between gap-3 bg-[var(--color-surface-muted)] px-4 py-3">
            <button
              type="button"
              onClick={() => setRows((prev) => [...prev, { cost_period_id: "", amount: "" }])}
              className="text-[13px] font-medium text-[var(--color-accent-strong)]"
            >
              + Agregar servicio
            </button>
            <span className="font-mono text-[13px] font-semibold text-[var(--color-ink)]">
              {formatAmount(assigned, currency)} / {formatAmount(netAmount, currency)}
            </span>
          </div>
        </Card>

        {overAssigned ? (
          <p className="text-[12.5px] text-[var(--color-negative-ink)]">Lo asignado supera el neto de la factura.</p>
        ) : null}
        {otherCurrency ? (
          <p className="text-[12.5px] text-[var(--color-warning-ink)]">
            Hay un servicio en otra moneda: el monto se toma en {currency}, la moneda de la factura.
          </p>
        ) : null}

        {state.error ? (
          <p className="text-[13px] text-[var(--color-negative-ink)]" role="alert">
            {state.error}
          </p>
        ) : null}
        {state.success ? (
          <p className="text-[13px] text-[var(--color-accent-strong)]" role="status">
            Asignación a servicios guardada.
          </p>
        ) : null}

        <div className="flex items-center gap-3">
          <Button
            type="submit"
            pending={pending}
            pendingLabel="Guardando…"
            disabled={overAssigned || incomplete}
            className="flex-1"
          >
            Guardar asignación a servicios
          </Button>
          <Link
            href={`/companies/${companyId}/costs/${documentId}`}
            className="text-[13px] text-[var(--color-muted)] hover:text-[var(--color-ink)]"
          >
            Volver
          </Link>
        </div>
        <p className="text-[11.5px] text-[var(--color-muted)]">
          Lo asignado es el costo real de cada período del servicio (reemplaza su costo fijo esperado). Lo que
          quede sin asignar sigue siendo costo general.
        </p>
      </form>
    </div>
  );
}
