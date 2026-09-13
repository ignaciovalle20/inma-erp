"use client";

import { useActionState } from "react";
import type { Client, BusinessArea, Project } from "@/lib/dal";
import { updateProject, type EditProjectState } from "./actions";
import { Field, FormActions, fieldInput } from "@/components/FormField";

const initialState: EditProjectState = { error: null };

export function EditProjectForm({
  companyId,
  project,
  clients,
  areas,
}: {
  companyId: string;
  project: Project;
  clients: Client[];
  areas: BusinessArea[];
}) {
  const updateProjectWithIds = updateProject.bind(
    null,
    companyId,
    project.id,
  );
  const [state, formAction, pending] = useActionState(
    updateProjectWithIds,
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
          defaultValue={project.name}
          className={fieldInput}
        />
      </Field>

      <Field label="Cliente" htmlFor="client_id">
        <select
          id="client_id"
          name="client_id"
          required
          defaultValue={project.client_id}
          className={fieldInput}
        >
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
          defaultValue={project.business_area_id}
          className={fieldInput}
        >
          {areas.map((area) => (
            <option key={area.id} value={area.id}>
              {area.name}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Estado" htmlFor="status">
        <select
          id="status"
          name="status"
          required
          defaultValue={project.status}
          className={fieldInput}
        >
          <option value="active">Activo</option>
          <option value="on_hold">En pausa</option>
          <option value="closed">Cerrado</option>
        </select>
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Fecha de inicio" htmlFor="start_date">
          <input
            id="start_date"
            name="start_date"
            type="date"
            defaultValue={project.start_date ?? ""}
            className={`${fieldInput} font-mono`}
          />
        </Field>
        <Field label="Fecha de fin" htmlFor="end_date">
          <input
            id="end_date"
            name="end_date"
            type="date"
            defaultValue={project.end_date ?? ""}
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
          defaultValue={project.budget ?? ""}
          className={`${fieldInput} font-mono`}
        />
      </Field>

      <Field label="Responsable" htmlFor="responsible">
        <input
          id="responsible"
          name="responsible"
          type="text"
          defaultValue={project.responsible ?? ""}
          className={fieldInput}
        />
      </Field>

      {state.error ? (
        <p className="text-[13px] text-[var(--color-negative-ink)]" role="alert">
          {state.error}
        </p>
      ) : null}

      <FormActions cancelHref={`/companies/${companyId}/projects`} pending={pending}>
        Guardar cambios
      </FormActions>
    </form>
  );
}
