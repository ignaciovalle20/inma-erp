"use client";

import { useActionState } from "react";
import type { Client, BusinessArea } from "@/lib/dal";
import { createProject, type CreateProjectState } from "./actions";
import { Field, FormActions, fieldInput } from "@/components/FormField";

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
}: {
  companyId: string;
  clients: Client[];
  areas: BusinessArea[];
}) {
  const createProjectWithCompany = createProject.bind(null, companyId);
  const [state, formAction, pending] = useActionState(
    createProjectWithCompany,
    initialState,
  );

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

      <Field label="Área de negocio" htmlFor="business_area_id">
        <select
          id="business_area_id"
          name="business_area_id"
          required
          defaultValue={state.values.business_area_id}
          className={fieldInput}
        >
          <option value="" disabled>
            Elegí un área
          </option>
          {areas.map((area) => (
            <option key={area.id} value={area.id}>
              {area.name}
            </option>
          ))}
        </select>
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
        <input
          id="budget"
          name="budget"
          type="number"
          step="0.01"
          defaultValue={state.values.budget}
          className={`${fieldInput} font-mono`}
        />
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
