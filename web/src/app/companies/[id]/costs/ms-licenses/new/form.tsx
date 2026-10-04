"use client";

import { useActionState, useState } from "react";
import type { Supplier } from "@/lib/dal";
import { createCostPool, type CreateCostPoolState } from "./actions";
import { Field, FormActions, fieldInput } from "@/components/FormField";
import { AmountInput } from "@/components/AmountInput";
import { currencyDecimals } from "@/lib/currencies";
import { formatDecimal } from "@/components/Money";
import { totalWithVat } from "@/lib/vat";
import { SERVICE_TYPES, SERVICE_TYPE_LABELS } from "@/lib/recurringServiceTypes";

const initialState: CreateCostPoolState = {
  error: null,
  values: {
    service_type: "",
    period: "",
    total_expense_amount: "",
    currency: "",
    supplier_id: "",
  },
};

export function NewCostPoolForm({
  companyId,
  country,
  suppliers,
}: {
  companyId: string;
  /** Company country: picks the IVA of the informative total (CL 19%, UY 22%). */
  country: string | null;
  suppliers: Supplier[];
}) {
  const createCostPoolWithCompany = createCostPool.bind(null, companyId);
  const [state, formAction, pending] = useActionState(
    createCostPoolWithCompany,
    initialState,
  );
  const [currency, setCurrency] = useState(state.values.currency);
  const [net, setNet] = useState(state.values.total_expense_amount);
  // Only a reference for checking against the supplier's invoice: the pool
  // (and every report) uses the net amount, never this total.
  const decimals = currencyDecimals(currency);
  const withVat = totalWithVat(Number(net), country, decimals);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <Field label="Tipo de servicio" htmlFor="service_type">
        <select
          id="service_type"
          name="service_type"
          required
          defaultValue={state.values.service_type}
          className={fieldInput}
        >
          <option value="" disabled>
            Elegí un tipo
          </option>
          {SERVICE_TYPES.map((type) => (
            <option key={type} value={type}>
              {SERVICE_TYPE_LABELS[type]}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Período" htmlFor="period">
        <input
          id="period"
          name="period"
          type="month"
          required
          defaultValue={state.values.period}
          className={`${fieldInput} font-mono`}
        />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Monto neto (sin IVA)" htmlFor="total_expense_amount">
          <AmountInput
            id="total_expense_amount"
            name="total_expense_amount"
            maxDecimals={decimals}
            required
            value={net}
            onValueChange={setNet}
            className={`${fieldInput} font-mono`}
          />
        </Field>
        <Field label="Moneda" htmlFor="currency">
          <select
            id="currency"
            name="currency"
            required
            value={currency}
            onChange={(event) => setCurrency(event.target.value)}
            className={fieldInput}
          >
            <option value="" disabled>
              Elegí moneda
            </option>
            <option value="CLP">CLP</option>
            <option value="UYU">UYU</option>
            <option value="USD">USD</option>
          </select>
        </Field>
      </div>

      <p className="-mt-2 text-[12px] text-[var(--color-muted)]" aria-live="polite">
        {withVat
          ? `Total con IVA (${Math.round(withVat.rate * 100)} %): ${formatDecimal(withVat.total, decimals)}${currency ? ` ${currency}` : ""} — solo informativo, no se guarda. Cargá el neto de la factura del proveedor: los reportes y el reparto son sin IVA.`
          : "Cargá el neto de la factura del proveedor (sin IVA): los reportes y el reparto son sin IVA."}
      </p>

      <Field label="Proveedor" htmlFor="supplier_id">
        <select
          id="supplier_id"
          name="supplier_id"
          defaultValue={state.values.supplier_id}
          className={fieldInput}
        >
          <option value="">Sin especificar</option>
          {suppliers.map((supplier) => (
            <option key={supplier.id} value={supplier.id}>
              {supplier.name}
            </option>
          ))}
        </select>
      </Field>

      {state.error ? (
        <p className="text-[13px] text-[var(--color-negative-ink)]" role="alert">
          {state.error}
        </p>
      ) : null}

      <FormActions
        cancelHref={`/companies/${companyId}/costs/ms-licenses`}
        pending={pending}
      >
        Crear pool de costo
      </FormActions>
    </form>
  );
}
