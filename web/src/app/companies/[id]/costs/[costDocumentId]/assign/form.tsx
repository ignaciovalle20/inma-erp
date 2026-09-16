"use client";

import { useActionState, useState } from "react";
import type { ProjectWithRelations } from "@/lib/dal";
import {
  assignCostDocumentToProject,
  type AssignCostDocumentState,
} from "./actions";
import { Field, FormActions } from "@/components/FormField";
import { Combobox } from "@/components/Combobox";

export function AssignCostDocumentForm({
  companyId,
  costDocumentId,
  projects,
}: {
  companyId: string;
  costDocumentId: string;
  projects: ProjectWithRelations[];
}) {
  const assignWithIds = assignCostDocumentToProject.bind(
    null,
    companyId,
    costDocumentId,
  );

  const initialState: AssignCostDocumentState = {
    error: null,
    values: { project_id: "" },
  };

  const [state, formAction, pending] = useActionState(assignWithIds, initialState);
  const [projectId, setProjectId] = useState(state.values.project_id);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <Field label="Trabajo" htmlFor="project_id">
        <Combobox
          id="project_id"
          name="project_id"
          required
          value={projectId}
          onChange={setProjectId}
          placeholder="Buscar un trabajo…"
          options={projects.map((project) => ({ value: project.id, label: project.name }))}
        />
        {projects.length === 0 ? (
          <p className="text-[11.5px] text-[var(--color-muted)]">
            No hay trabajos activos --{" "}
            <a className="text-[var(--color-accent-strong)]" href={`/companies/${companyId}/projects`}>
              agregá uno primero
            </a>
            .
          </p>
        ) : null}
      </Field>

      {state.error ? (
        <p className="text-[13px] text-[var(--color-negative-ink)]" role="alert">
          {state.error}
        </p>
      ) : null}

      <FormActions
        cancelHref={`/companies/${companyId}/costs`}
        pending={pending}
        pendingLabel="Asignando…"
      >
        Asignar
      </FormActions>
    </form>
  );
}
