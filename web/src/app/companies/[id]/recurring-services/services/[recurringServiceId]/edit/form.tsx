"use client";

import { useActionState, useState } from "react";
import type {
  Client,
  RecurringService,
  RecurringServicePeriodicity,
  BusinessArea,
} from "@/lib/dal";
import {
  updateRecurringService,
  type EditRecurringServiceState,
} from "./actions";
import { Field, FormActions, fieldInput, fieldLabel } from "@/components/FormField";
import { AmountInput } from "@/components/AmountInput";
import { currencyDecimals } from "@/lib/currencies";
import { CurrencyField } from "../../../currency-field";
import {
  SERVICE_TYPES,
  SERVICE_TYPE_LABELS,
  SERVICE_TYPE_TO_AREA_NAME,
  INVOICING_MODES,
  INVOICING_MODE_LABELS,
  RECURRING_SERVICE_STATUSES,
  RECURRING_SERVICE_STATUS_LABELS,
  type ServiceType,
  type ServiceCountry,
} from "@/lib/recurringServiceTypes";

const initialState: EditRecurringServiceState = { error: null };

export function EditRecurringServiceForm({
  companyId,
  clients,
  businessAreas,
  recurringService,
  country,
}: {
  companyId: string;
  clients: Client[];
  businessAreas: BusinessArea[];
  recurringService: RecurringService;
  country: ServiceCountry | null;
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
  const [currency, setCurrency] = useState(
    country === "CL" ? "CLP" : recurringService.currency,
  );
  const [periodicity, setPeriodicity] = useState(recurringService.periodicity);
  const [businessAreaId, setBusinessAreaId] = useState(
    recurringService.business_area_id ?? "",
  );
  const [usesCostPool, setUsesCostPool] = useState(
    recurringService.uses_cost_pool,
  );

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
        <Field label="Tipo de servicio" htmlFor="service_type">
          <select
            id="service_type"
            name="service_type"
            defaultValue={recurringService.service_type ?? ""}
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
        <CurrencyField country={country} value={currency} onChange={setCurrency} />
        <Field label="Periodicidad" htmlFor="periodicity">
          <select
            id="periodicity"
            name="periodicity"
            required
            value={periodicity}
            onChange={(event) =>
              setPeriodicity(event.target.value as RecurringServicePeriodicity)
            }
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
            defaultValue={recurringService.invoicing_mode}
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
            defaultValue={recurringService.due_day ?? ""}
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
            defaultValue={recurringService.due_month ?? ""}
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

      <Field label="Referencia de cotización" htmlFor="quote_ref">
        <input
          id="quote_ref"
          name="quote_ref"
          type="text"
          placeholder="Opcional -- solo si el cliente pide cotización mensual"
          defaultValue={recurringService.quote_ref ?? ""}
          className={fieldInput}
        />
      </Field>

      <Field label="Detalle / notas" htmlFor="notes">
        <textarea
          id="notes"
          name="notes"
          rows={2}
          placeholder="Ej. 23 STD / 3 XCH2 / 10 XCH1 · Facturar según HES · contacto"
          defaultValue={recurringService.notes ?? ""}
          className={fieldInput}
        />
      </Field>

      <div className="flex items-center gap-2">
        <input
          id="requires_invoice"
          name="requires_invoice"
          type="checkbox"
          defaultChecked={recurringService.requires_invoice}
          className="h-4 w-4 rounded border-[var(--color-hairline)]"
        />
        <label htmlFor="requires_invoice" className={fieldLabel}>
          Requiere factura (si no, cada mes arranca en &quot;Cobrar&quot;)
        </label>
      </div>

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
            defaultValue={recurringService.fixed_monthly_cost ?? ""}
            className={`${fieldInput} font-mono`}
          />
        </Field>
      ) : null}

      <Field label="Estado" htmlFor="status">
        <select
          id="status"
          name="status"
          required
          defaultValue={recurringService.status}
          className={fieldInput}
        >
          {RECURRING_SERVICE_STATUSES.map((status) => (
            <option key={status} value={status}>
              {RECURRING_SERVICE_STATUS_LABELS[status]}
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
        cancelHref={`/companies/${companyId}/recurring-services/services/${recurringService.id}`}
        pending={pending}
      >
        Guardar cambios
      </FormActions>
    </form>
  );
}
