"use client";

import { useActionState, useState } from "react";
import type { Client } from "@/lib/dal";
import {
  createRecurringService,
  type CreateRecurringServiceState,
} from "./actions";
import { Field, FormActions, fieldInput } from "@/components/FormField";
import { AmountInput } from "@/components/AmountInput";
import { currencyDecimals } from "@/lib/currencies";

const initialState: CreateRecurringServiceState = {
  error: null,
  values: {
    client_id: "",
    name: "",
    price: "",
    expected_cost: "",
    currency: "",
    periodicity: "monthly",
    start_date: "",
    end_date: "",
  },
};

export function NewRecurringServiceForm({
  companyId,
  clients,
}: {
  companyId: string;
  clients: Client[];
}) {
  const createRecurringServiceWithCompany = createRecurringService.bind(
    null,
    companyId,
  );
  const [state, formAction, pending] = useActionState(
    createRecurringServiceWithCompany,
    initialState,
  );
  const [currency, setCurrency] = useState(state.values.currency);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <Field label="Cliente" htmlFor="client_id">
        <select
          id="client_id"
          name="client_id"
          required
          defaultValue={state.values.client_id}
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
      </Field>

      <Field label="Nombre del servicio" htmlFor="name">
        <input
          id="name"
          name="name"
          type="text"
          required
          defaultValue={state.values.name}
          className={fieldInput}
        />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Precio" htmlFor="price">
          <AmountInput
            id="price"
            name="price"
            maxDecimals={currencyDecimals(currency)}
            required
            defaultValue={state.values.price}
            className={`${fieldInput} font-mono`}
          />
        </Field>
        <Field label="Costo esperado" htmlFor="expected_cost">
          <AmountInput
            id="expected_cost"
            name="expected_cost"
            maxDecimals={currencyDecimals(currency)}
            defaultValue={state.values.expected_cost}
            className={`${fieldInput} font-mono`}
          />
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-3">
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
        <Field label="Periodicidad" htmlFor="periodicity">
          <select
            id="periodicity"
            name="periodicity"
            required
            defaultValue={state.values.periodicity}
            className={fieldInput}
          >
            <option value="monthly">Mensual</option>
            <option value="annual">Anual</option>
          </select>
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Fecha de inicio" htmlFor="start_date">
          <input
            id="start_date"
            name="start_date"
            type="date"
            required
            defaultValue={state.values.start_date}
            className={`${fieldInput} font-mono`}
          />
        </Field>
        <Field label="Fecha de fin" htmlFor="end_date">
          <input
            id="end_date"
            name="end_date"
            type="date"
            defaultValue={state.values.end_date}
            className={`${fieldInput} font-mono`}
          />
        </Field>
      </div>

      {state.error ? (
        <p className="text-[13px] text-[var(--color-negative-ink)]" role="alert">
          {state.error}
        </p>
      ) : null}

      <FormActions
        cancelHref={`/companies/${companyId}/recurring-services`}
        pending={pending}
      >
        Crear servicio recurrente
      </FormActions>
    </form>
  );
}
