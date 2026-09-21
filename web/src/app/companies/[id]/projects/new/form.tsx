"use client";

import { useActionState, useMemo, useState } from "react";
import type { Client, BusinessArea } from "@/lib/dal";
import { createProject, createClientQuick, type CreateProjectState } from "./actions";
import { Field, FormActions, fieldInput, fieldLabel } from "@/components/FormField";
import { Combobox } from "@/components/Combobox";
import { AmountInput } from "@/components/AmountInput";
import { currencyDecimals } from "@/lib/currencies";
import { QuickAddClient } from "@/components/QuickAddClient";
import { PROJECT_STATUSES, PROJECT_STATUS_LABEL } from "@/lib/projectStatus";

type ClientOption = Pick<Client, "id" | "name" | "invoiceable">;

export function NewProjectForm({
  companyId,
  clients,
  areas,
  currency,
  initialValues,
}: {
  companyId: string;
  clients: Client[];
  areas: BusinessArea[];
  currency: string;
  initialValues?: {
    name?: string;
    client_id?: string;
    business_area_id?: string;
    invoiceable?: boolean;
  };
}) {
  const initialState: CreateProjectState = {
    error: null,
    values: {
      name: initialValues?.name ?? "",
      client_id: initialValues?.client_id ?? "",
      business_area_id: initialValues?.business_area_id ?? "",
      status: "en_ejecucion",
      quote_number: "",
      start_date: "",
      end_date: "",
      budget: "",
      responsible: "",
      invoiceable: initialValues?.invoiceable ?? true,
    },
  };

  const createProjectWithCompany = createProject.bind(null, companyId);
  const createClientQuickWithCompany = createClientQuick.bind(null, companyId);
  const [state, formAction, pending] = useActionState(
    createProjectWithCompany,
    initialState,
  );
  const [clientOptions, setClientOptions] = useState<ClientOption[]>(clients);
  const [clientId, setClientId] = useState(state.values.client_id);
  const [businessAreaId, setBusinessAreaId] = useState(state.values.business_area_id);
  const [status, setStatus] = useState(state.values.status);
  const [invoiceable, setInvoiceable] = useState(state.values.invoiceable);

  const selectedClient = useMemo(
    () => clientOptions.find((client) => client.id === clientId) ?? null,
    [clientOptions, clientId],
  );

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <Field label="N° de cotización" htmlFor="quote_number" hint={
        status === "por_cotizar"
          ? "Opcional mientras el trabajo esté \"Por cotizar\"."
          : undefined
      }>
        <input
          id="quote_number"
          name="quote_number"
          type="text"
          required={status !== "por_cotizar"}
          defaultValue={state.values.quote_number}
          className={`${fieldInput} font-mono`}
        />
      </Field>

      <Field label="Cliente" htmlFor="client_id">
        <div className="flex flex-col gap-2">
          <Combobox
            id="client_id"
            name="client_id"
            required
            value={clientId}
            onChange={(value) => {
              setClientId(value);
              const client = clientOptions.find((c) => c.id === value);
              if (client) {
                setInvoiceable(client.invoiceable);
              }
            }}
            placeholder="Buscar un cliente…"
            options={clientOptions.map((client) => ({ value: client.id, label: client.name }))}
          />
          <QuickAddClient
            createClientQuick={createClientQuickWithCompany}
            onCreated={(client) => {
              setClientOptions((current) => [
                ...current,
                { id: client.id, name: client.name, invoiceable: client.invoiceable },
              ]);
              setClientId(client.id);
              setInvoiceable(client.invoiceable);
            }}
          />
        </div>
      </Field>

      <Field label="Descripción" htmlFor="name">
        <input
          id="name"
          name="name"
          type="text"
          required
          defaultValue={state.values.name}
          className={fieldInput}
        />
      </Field>

      <Field label="Área de negocio" htmlFor="business_area_id">
        <Combobox
          id="business_area_id"
          name="business_area_id"
          required
          value={businessAreaId}
          onChange={setBusinessAreaId}
          placeholder="Buscar un área…"
          options={areas.map((area) => ({ value: area.id, label: area.name }))}
        />
      </Field>

      <Field label="Estado" htmlFor="status">
        <select
          id="status"
          name="status"
          required
          value={status}
          onChange={(event) => setStatus(event.target.value as typeof status)}
          className={fieldInput}
        >
          {PROJECT_STATUSES.filter((value) => value !== "cerrado" && value !== "cancelado").map(
            (value) => (
              <option key={value} value={value}>
                {PROJECT_STATUS_LABEL[value]}
              </option>
            ),
          )}
        </select>
      </Field>

      <Field label="Monto neto cotizado" htmlFor="budget">
        <div className="grid grid-cols-[1fr_90px] gap-2">
          <AmountInput
            id="budget"
            name="budget"
            maxDecimals={currencyDecimals(currency)}
            defaultValue={state.values.budget}
            className={`${fieldInput} font-mono`}
          />
          <select
            disabled
            defaultValue={currency}
            aria-label="Moneda del monto cotizado"
            className={`${fieldInput} font-mono`}
          >
            <option value={currency}>{currency}</option>
          </select>
        </div>
      </Field>

      <div className="flex items-center gap-2">
        <input
          id="invoiceable"
          name="invoiceable"
          type="checkbox"
          checked={invoiceable}
          onChange={(event) => setInvoiceable(event.target.checked)}
          className="h-4 w-4 rounded border-[var(--color-hairline)]"
        />
        <label htmlFor="invoiceable" className={fieldLabel}>
          Facturable
        </label>
        {selectedClient && !selectedClient.invoiceable ? (
          <span className="text-[11.5px] text-[var(--color-muted)]">
            (este cliente es &quot;sin factura&quot; por defecto)
          </span>
        ) : null}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Fecha de inicio" htmlFor="start_date">
          <input
            id="start_date"
            name="start_date"
            type="date"
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

      <Field label="Responsable" htmlFor="responsible">
        <input
          id="responsible"
          name="responsible"
          type="text"
          defaultValue={state.values.responsible}
          className={fieldInput}
        />
      </Field>

      {state.error ? (
        <p className="text-[13px] text-[var(--color-negative-ink)]" role="alert">
          {state.error}
        </p>
      ) : null}

      <FormActions cancelHref={`/companies/${companyId}/projects/board`} pending={pending}>
        Crear trabajo
      </FormActions>
    </form>
  );
}
