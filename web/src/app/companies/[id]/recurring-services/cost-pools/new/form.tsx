"use client";

import { useActionState, useState } from "react";
import type { Supplier } from "@/lib/dal";
import { createCostPool, type CreateCostPoolState } from "./actions";
import { Field, FormActions, fieldInput } from "@/components/FormField";
import { AmountInput } from "@/components/AmountInput";
import { currencyDecimals } from "@/lib/currencies";
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
  suppliers,
}: {
  companyId: string;
  suppliers: Supplier[];
}) {
  const createCostPoolWithCompany = createCostPool.bind(null, companyId);
  const [state, formAction, pending] = useActionState(
    createCostPoolWithCompany,
    initialState,
  );
  const [currency, setCurrency] = useState(state.values.currency);

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
        <Field label="Monto total de la factura" htmlFor="total_expense_amount">
          <AmountInput
            id="total_expense_amount"
            name="total_expense_amount"
            maxDecimals={currencyDecimals(currency)}
            required
            defaultValue={state.values.total_expense_amount}
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
        cancelHref={`/companies/${companyId}/recurring-services/cost-pools`}
        pending={pending}
      >
        Crear pool de costo
      </FormActions>
    </form>
  );
}
