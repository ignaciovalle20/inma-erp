"use client";

import { useActionState, useState } from "react";
import type { Client, BusinessArea } from "@/lib/dal";
import {
  createRecurringService,
  type CreateRecurringServiceState,
} from "./actions";
import { Field, FormActions, fieldInput, fieldLabel } from "@/components/FormField";
import { CurrencyField } from "../../currency-field";
import { PricingFields } from "../../pricing-fields";
import { AnnualDueMonthNote, CostFields } from "../../cost-fields";
import {
  SERVICE_TYPES,
  SERVICE_TYPE_LABELS,
  suggestedBusinessAreaId,
  INVOICING_MODES,
  INVOICING_MODE_LABELS,
  defaultCostPeriodicity,
  type CostPeriodicity,
  type ServiceCountry,
} from "@/lib/recurringServiceTypes";

const initialState: CreateRecurringServiceState = {
  error: null,
  values: {
    client_id: "",
    name: "",
    pricing_mode: "fixed",
    reference_amount: "",
    unit_price: "",
    default_quantity: "",
    currency: "",
    periodicity: "monthly",
    start_date: "",
    end_date: "",
    business_area_id: "",
    service_type: "",
    invoicing_mode: "arrears",
    due_day: "",
    fixed_cost: "",
    cost_periodicity: "monthly",
    supplier_id: "",
    uses_cost_pool: false,
    quote_ref: "",
    requires_invoice: true,
    notes: "",
  },
};

export function NewRecurringServiceForm({
  companyId,
  clients,
  businessAreas,
  suppliers,
  country,
}: {
  companyId: string;
  clients: Client[];
  businessAreas: BusinessArea[];
  /** Active suppliers of the company. */
  suppliers: { id: string; name: string }[];
  country: ServiceCountry | null;
}) {
  const createRecurringServiceWithCompany = createRecurringService.bind(
    null,
    companyId,
  );
  const [state, formAction, pending] = useActionState(
    createRecurringServiceWithCompany,
    initialState,
  );
  const [currency, setCurrency] = useState(
    country === "CL" ? "CLP" : state.values.currency,
  );
  const [periodicity, setPeriodicity] = useState(state.values.periodicity);
  const [businessAreaId, setBusinessAreaId] = useState(
    state.values.business_area_id,
  );
  const [usesCostPool, setUsesCostPool] = useState(state.values.uses_cost_pool);
  const [startDate, setStartDate] = useState(state.values.start_date);
  const [invoicingMode, setInvoicingMode] = useState(state.values.invoicing_mode);
  const [costPeriodicity, setCostPeriodicity] = useState<CostPeriodicity>(
    state.values.cost_periodicity === "annual" ? "annual" : "monthly",
  );

  // Suggests (never forces) the business area that matches the chosen
  // service type, per plan-servicios-recurrentes.md's mapping table --
  // "otro" has no fixed mapping, so the select is left as-is. The user
  // can still change the area manually afterward either way.
  function handleServiceTypeChange(value: string) {
    // A domain renews once a year (its due month/day is the renewal date),
    // and its cost is paid once a year too.
    if (value === "domain") setPeriodicity("annual");
    setCostPeriodicity(defaultCostPeriodicity(value));
    const areaId = suggestedBusinessAreaId(value, businessAreas);
    if (areaId) setBusinessAreaId(areaId);
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

      <PricingFields
        currency={currency}
        defaults={{
          pricing_mode: state.values.pricing_mode,
          reference_amount: state.values.reference_amount,
          unit_price: state.values.unit_price,
          default_quantity: state.values.default_quantity,
        }}
      />

      <div className="grid grid-cols-2 gap-3">
        <CurrencyField country={country} value={currency} onChange={setCurrency} />
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
            value={invoicingMode}
            onChange={(event) => setInvoicingMode(event.target.value)}
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

      <div className="grid grid-cols-2 gap-3">
        <Field label="Fecha de inicio" htmlFor="start_date">
          <input
            id="start_date"
            name="start_date"
            type="date"
            required
            value={startDate}
            onChange={(event) => setStartDate(event.target.value)}
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

      {periodicity === "annual" ? <AnnualDueMonthNote startDate={startDate} invoicingMode={invoicingMode} /> : null}

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

      <Field label="Detalle / notas" htmlFor="notes">
        <textarea
          id="notes"
          name="notes"
          rows={2}
          placeholder="Ej. 23 STD / 3 XCH2 / 10 XCH1 · Facturar según HES · contacto"
          defaultValue={state.values.notes}
          className={fieldInput}
        />
      </Field>

      <div className="flex items-center gap-2">
        <input
          id="requires_invoice"
          name="requires_invoice"
          type="checkbox"
          defaultChecked={state.values.requires_invoice}
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
        <CostFields
          currency={currency}
          suppliers={suppliers}
          fixedCostDefault={state.values.fixed_cost}
          supplierDefault={state.values.supplier_id || null}
          costPeriodicity={costPeriodicity}
          onCostPeriodicityChange={setCostPeriodicity}
        />
      ) : null}

      {state.error ? (
        <p className="text-[13px] text-[var(--color-negative-ink)]" role="alert">
          {state.error}
        </p>
      ) : null}

      <FormActions
        cancelHref={`/companies/${companyId}/recurring-services/services`}
        pending={pending}
      >
        Crear servicio recurrente
      </FormActions>
    </form>
  );
}
