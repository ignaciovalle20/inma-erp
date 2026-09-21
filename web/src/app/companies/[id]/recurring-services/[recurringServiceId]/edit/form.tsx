"use client";

import { useActionState, useState } from "react";
import type { Client, RecurringService } from "@/lib/dal";
import {
  updateRecurringService,
  type EditRecurringServiceState,
} from "./actions";
import { Field, FormActions, fieldInput, fieldLabel } from "@/components/FormField";
import { AmountInput } from "@/components/AmountInput";
import { currencyDecimals } from "@/lib/currencies";

const initialState: EditRecurringServiceState = { error: null };

export function EditRecurringServiceForm({
  companyId,
  clients,
  recurringService,
}: {
  companyId: string;
  clients: Client[];
  recurringService: RecurringService;
}) {
  const updateRecurringServiceWithIds = updateRecurringService.bind(
    null,
    companyId,
    recurringService.id,
  );
  const [state, formAction, pending] = useActionState(
    updateRecurringServiceWithIds,
    initialState,
  );
  const [currency, setCurrency] = useState(recurringService.currency);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <Field label="Cliente" htmlFor="client_id">
        <select
          id="client_id"
          name="client_id"
          required
          defaultValue={recurringService.client_id}
          className={fieldInput}
        >
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
          defaultValue={recurringService.name}
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
            defaultValue={recurringService.price}
            className={`${fieldInput} font-mono`}
          />
        </Field>
        <Field label="Costo esperado" htmlFor="expected_cost">
          <AmountInput
            id="expected_cost"
            name="expected_cost"
            maxDecimals={currencyDecimals(currency)}
            defaultValue={recurringService.expected_cost}
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
            defaultValue={recurringService.periodicity}
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
            defaultValue={recurringService.start_date}
            className={`${fieldInput} font-mono`}
          />
        </Field>
        <Field label="Fecha de fin" htmlFor="end_date">
          <input
            id="end_date"
            name="end_date"
            type="date"
            defaultValue={recurringService.end_date ?? ""}
            className={`${fieldInput} font-mono`}
          />
        </Field>
      </div>

      <div className="flex items-center gap-2">
        <input
          id="active"
          name="active"
          type="checkbox"
          defaultChecked={recurringService.active}
          className="h-4 w-4 rounded border-[var(--color-hairline)]"
        />
        <label htmlFor="active" className={fieldLabel}>
          Activo
        </label>
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
        Guardar cambios
      </FormActions>
    </form>
  );
}
