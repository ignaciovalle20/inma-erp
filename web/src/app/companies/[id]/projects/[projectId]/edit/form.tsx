"use client";

import { useActionState, useState } from "react";
import type { Client, BusinessArea, Project } from "@/lib/dal";
import { updateProject, type EditProjectState } from "./actions";
import { Field, FormActions, fieldInput, fieldLabel } from "@/components/FormField";
import { PROJECT_STATUSES, PROJECT_STATUS_LABEL } from "@/lib/projectStatus";

const initialState: EditProjectState = { error: null };

export function EditProjectForm({
  companyId,
  project,
  clients,
  areas,
  currency,
}: {
  companyId: string;
  project: Project;
  clients: Client[];
  areas: BusinessArea[];
  currency: string;
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
  const [status, setStatus] = useState(project.status);

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
          value={status}
          onChange={(event) => setStatus(event.target.value as typeof status)}
          className={fieldInput}
        >
          {PROJECT_STATUSES.map((value) => (
            <option key={value} value={value}>
              {PROJECT_STATUS_LABEL[value]}
            </option>
          ))}
        </select>
      </Field>

      {status === "en_espera" ? (
        <Field label="Motivo de la espera" htmlFor="hold_reason">
          <input
            id="hold_reason"
            name="hold_reason"
            type="text"
            required
            defaultValue={project.hold_reason ?? ""}
            className={fieldInput}
          />
        </Field>
      ) : null}

      <div className="flex items-center gap-2">
        <input
          id="invoiceable"
          name="invoiceable"
          type="checkbox"
          defaultChecked={project.invoiceable}
          className="h-4 w-4 rounded border-[var(--color-hairline)]"
        />
        <label htmlFor="invoiceable" className={fieldLabel}>
          Facturable
        </label>
      </div>

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

      <Field label="Monto cotizado" htmlFor="budget">
        <div className="grid grid-cols-[1fr_90px] gap-2">
          <input
            id="budget"
            name="budget"
            type="number"
            step="0.01"
            defaultValue={project.budget ?? ""}
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
