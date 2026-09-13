"use client";

import { useActionState } from "react";
import type { Personnel } from "@/lib/dal";
import { updatePersonnel, type EditPersonnelState } from "./actions";
import { Field, FormActions, fieldInput, fieldLabel } from "@/components/FormField";

const initialState: EditPersonnelState = { error: null };

export function EditPersonnelForm({
  companyId,
  person,
}: {
  companyId: string;
  person: Personnel;
}) {
  const updatePersonnelWithIds = updatePersonnel.bind(
    null,
    companyId,
    person.id,
  );
  const [state, formAction, pending] = useActionState(
    updatePersonnelWithIds,
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
          defaultValue={person.name}
          className={fieldInput}
        />
      </Field>

      <Field label="Tipo" htmlFor="type">
        <select
          id="type"
          name="type"
          required
          defaultValue={person.type}
          className={fieldInput}
        >
          <option value="employee">Empleado</option>
          <option value="partner">Socio</option>
        </select>
      </Field>

      <div className="flex items-center gap-2">
        <input
          id="active"
          name="active"
          type="checkbox"
          defaultChecked={person.active}
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

      <FormActions cancelHref={`/companies/${companyId}/personnel`} pending={pending}>
        Guardar cambios
      </FormActions>
    </form>
  );
}
