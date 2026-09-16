"use client";

import { useActionState, useState } from "react";
import type { Client, BusinessArea } from "@/lib/dal";
import { createProject, type CreateProjectState } from "./actions";
import { Field, FormActions, fieldInput } from "@/components/FormField";
import { Combobox } from "@/components/Combobox";

const initialState: CreateProjectState = {
  error: null,
  values: {
    name: "",
    client_id: "",
    business_area_id: "",
    start_date: "",
    end_date: "",
    budget: "",
    responsible: "",
  },
};

export function NewProjectForm({
  companyId,
  clients,
  areas,
  currency,
}: {
  companyId: string;
  clients: Client[];
  areas: BusinessArea[];
  currency: string;
}) {
  const createProjectWithCompany = createProject.bind(null, companyId);
  const [state, formAction, pending] = useActionState(
    createProjectWithCompany,
    initialState,
  );
  const [clientId, setClientId] = useState(state.values.client_id);
  const [businessAreaId, setBusinessAreaId] = useState(state.values.business_area_id);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <Field label="Nombre" htmlFor="name">
        <input
          id="name"
          name="name"
          type="text"
          required
          defaultValue={state.values.name}
          className={fieldInput}
        />
      </Field>

      <Field label="Cliente" htmlFor="client_id">
        <Combobox
          id="client_id"
          name="client_id"
          required
          value={clientId}
          onChange={setClientId}
          placeholder="Buscar un cliente…"
          options={clients.map((client) => ({ value: client.id, label: client.name }))}
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

      <Field label="Presupuesto" htmlFor="budget">
        <div className="grid grid-cols-[1fr_90px] gap-2">
          <input
            id="budget"
            name="budget"
            type="number"
            step="0.01"
            defaultValue={state.values.budget}
            className={`${fieldInput} font-mono`}
          />
          <select
            disabled
            defaultValue={currency}
            aria-label="Moneda del presupuesto"
            className={`${fieldInput} font-mono`}
          >
            <option value={currency}>{currency}</option>
          </select>
        </div>
      </Field>

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

      <FormActions cancelHref={`/companies/${companyId}/projects`} pending={pending}>
        Crear proyecto
      </FormActions>
    </form>
  );
}
