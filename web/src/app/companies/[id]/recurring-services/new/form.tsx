"use client";

import { useActionState, useState } from "react";
import type { Client, BusinessArea } from "@/lib/dal";
import {
  createRecurringService,
  type CreateRecurringServiceState,
} from "./actions";
import { Field, FormActions, fieldInput, fieldLabel } from "@/components/FormField";
import { AmountInput } from "@/components/AmountInput";
import { currencyDecimals } from "@/lib/currencies";
import {
  SERVICE_TYPES,
  SERVICE_TYPE_LABELS,
  SERVICE_TYPE_TO_AREA_NAME,
  INVOICING_MODES,
  INVOICING_MODE_LABELS,
  type ServiceType,
} from "@/lib/recurringServiceTypes";

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
    business_area_id: "",
    service_type: "",
    invoicing_mode: "arrears",
    due_day: "",
    due_month: "",
    fixed_monthly_cost: "",
    uses_cost_pool: false,
    quote_ref: "",
  },
};

export function NewRecurringServiceForm({
  companyId,
  clients,
  businessAreas,
}: {
  companyId: string;
  clients: Client[];
  businessAreas: BusinessArea[];
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
  const [periodicity, setPeriodicity] = useState(state.values.periodicity);
  const [businessAreaId, setBusinessAreaId] = useState(
    state.values.business_area_id,
  );
  const [usesCostPool, setUsesCostPool] = useState(state.values.uses_cost_pool);

  // Suggests (never forces) the business area that matches the chosen
  // service type, per plan-servicios-recurrentes.md's mapping table --
  // "otro" has no fixed mapping, so the select is left as-is. The user
  // can still change the area manually afterward either way.
  function handleServiceTypeChange(value: string) {
    const areaName = SERVICE_TYPE_TO_AREA_NAME[value as ServiceType];
    if (!areaName) return;
    const match = businessAreas.find((area) => area.name === areaName);
    if (match) setBusinessAreaId(match.id);
  }

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
        <Field label="Tipo de servicio" htmlFor="service_type">
          <select
            id="service_type"
            name="service_type"
            defaultValue={state.values.service_type}
            onChange={(event) => handleServiceTypeChange(event.target.value)}
            className={fieldInput}
          >
            <option value="">Sin especificar</option>
            {SERVICE_TYPES.map((type) => (
              <option key={type} value={type}>
                {SERVICE_TYPE_LABELS[type]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Área de negocio" htmlFor="business_area_id">
          <select
            id="business_area_id"
            name="business_area_id"
            value={businessAreaId}
            onChange={(event) => setBusinessAreaId(event.target.value)}
            className={fieldInput}
          >
            <option value="">Sin especificar</option>
            {businessAreas.map((area) => (
              <option key={area.id} value={area.id}>
                {area.name}
              </option>
            ))}
          </select>
        </Field>
      </div>

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
            value={periodicity}
            onChange={(event) => setPeriodicity(event.target.value)}
            className={fieldInput}
          >
            <option value="monthly">Mensual</option>
            <option value="annual">Anual</option>
          </select>
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Modalidad de facturación" htmlFor="invoicing_mode">
          <select
            id="invoicing_mode"
            name="invoicing_mode"
            required
            defaultValue={state.values.invoicing_mode}
            className={fieldInput}
          >
            {INVOICING_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {INVOICING_MODE_LABELS[mode]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Día de vencimiento" htmlFor="due_day">
          <input
            id="due_day"
            name="due_day"
            type="number"
            min={1}
            max={31}
            defaultValue={state.values.due_day}
            className={`${fieldInput} font-mono`}
          />
        </Field>
      </div>

      {periodicity === "annual" ? (
        <Field label="Mes de vencimiento" htmlFor="due_month">
          <input
            id="due_month"
            name="due_month"
            type="number"
            min={1}
            max={12}
            required
            defaultValue={state.values.due_month}
            className={`${fieldInput} font-mono`}
          />
        </Field>
      ) : null}

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

      <Field label="Referencia de cotización" htmlFor="quote_ref">
        <input
          id="quote_ref"
          name="quote_ref"
          type="text"
          placeholder="Opcional -- solo si el cliente pide cotización mensual"
          defaultValue={state.values.quote_ref}
          className={fieldInput}
        />
      </Field>

      <div className="flex items-center gap-2">
        <input
          id="uses_cost_pool"
          name="uses_cost_pool"
          type="checkbox"
          checked={usesCostPool}
          onChange={(event) => setUsesCostPool(event.target.checked)}
          className="h-4 w-4 rounded border-[var(--color-hairline)]"
        />
        <label htmlFor="uses_cost_pool" className={fieldLabel}>
          Usa pool de costo compartido (ej. licencias MS)
        </label>
      </div>

      {!usesCostPool ? (
        <Field label="Costo fijo mensual" htmlFor="fixed_monthly_cost">
          <AmountInput
            id="fixed_monthly_cost"
            name="fixed_monthly_cost"
            maxDecimals={currencyDecimals(currency)}
            defaultValue={state.values.fixed_monthly_cost}
            className={`${fieldInput} font-mono`}
          />
        </Field>
      ) : null}

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
