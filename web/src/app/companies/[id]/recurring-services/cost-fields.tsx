"use client";

import { Field, fieldInput } from "@/components/FormField";
import { AmountInput } from "@/components/AmountInput";
import { currencyDecimals } from "@/lib/currencies";
import {
  COST_PERIODICITIES,
  COST_PERIODICITY_LABELS,
  annualDueMonth,
  monthName,
  type CostPeriodicity,
} from "@/lib/recurringServiceTypes";

/**
 * The service's own cost (20261020010000): a fixed cost net of VAT, how
 * often it is paid -- independent of how the service is sold -- and the
 * supplier whose invoices go to its cost periods. Not shown for a pooled
 * service (MS licenses): the pool carries its cost.
 */
export function CostFields({
  currency,
  suppliers,
  fixedCostDefault,
  supplierDefault,
  costPeriodicity,
  onCostPeriodicityChange,
}: {
  currency: string;
  /** Active suppliers of the company (plus the current one when editing). */
  suppliers: { id: string; name: string }[];
  fixedCostDefault: string | number | null;
  supplierDefault: string | null;
  costPeriodicity: CostPeriodicity;
  onCostPeriodicityChange: (value: CostPeriodicity) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Costo fijo" htmlFor="fixed_cost">
          <AmountInput
            id="fixed_cost"
            name="fixed_cost"
            maxDecimals={currencyDecimals(currency)}
            defaultValue={fixedCostDefault ?? ""}
            placeholder="Neto, sin IVA"
            className={`${fieldInput} font-mono`}
          />
        </Field>
        <Field label="Se paga" htmlFor="cost_periodicity">
          <select
            id="cost_periodicity"
            name="cost_periodicity"
            value={costPeriodicity}
            onChange={(event) => onCostPeriodicityChange(event.target.value as CostPeriodicity)}
            className={fieldInput}
          >
            {COST_PERIODICITIES.map((value) => (
              <option key={value} value={value}>
                {COST_PERIODICITY_LABELS[value]}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <p className="text-[11.5px] text-[var(--color-muted)]">
        Neto de IVA. Se imputa {costPeriodicity === "monthly" ? "en cada mes del servicio" : "en el mes de cada renovación (aniversario de la fecha de inicio)"}.
        Si se asigna una factura real a ese período, cuenta el monto de la factura en lugar del costo fijo.
      </p>
      <Field label="Proveedor" htmlFor="supplier_id">
        <select id="supplier_id" name="supplier_id" defaultValue={supplierDefault ?? ""} className={fieldInput}>
          <option value="">Sin proveedor</option>
          {suppliers.map((supplier) => (
            <option key={supplier.id} value={supplier.id}>
              {supplier.name}
            </option>
          ))}
        </select>
      </Field>
    </div>
  );
}

/** The due month of an annual service, calculated (never asked). */
export function AnnualDueMonthNote({ startDate, invoicingMode }: { startDate: string; invoicingMode: string }) {
  const month = annualDueMonth(startDate, invoicingMode);
  return (
    <p className="rounded-md bg-[var(--color-row)] px-3 py-2 text-[12px] text-[var(--color-ink-2)]">
      {month === null
        ? "El mes de vencimiento se calcula con la fecha de inicio."
        : invoicingMode === "advance"
          ? `Vence cada año en ${monthName(month)}: el mes en que empieza cada período anual (aniversario de la fecha de inicio).`
          : `Vence cada año en ${monthName(month)}: el mes en que termina cada período anual.`}
    </p>
  );
}
