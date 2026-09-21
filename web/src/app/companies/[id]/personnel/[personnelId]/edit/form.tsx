"use client";

import { useActionState } from "react";
import type { Personnel } from "@/lib/dal";
import { technicianFormValuesOf } from "@/lib/technicians";
import { updatePersonnel, type EditPersonnelState } from "./actions";
import { Field, FormActions, fieldInput, fieldLabel } from "@/components/FormField";
import { TechnicianFields } from "../../technician-fields";

const initialState: EditPersonnelState = { error: null };

export function EditPersonnelForm({
  companyId,
  person,
  currency,
}: {
  companyId: string;
  person: Personnel;
  currency: string;
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
  const isContractor = person.type === "contractor";

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

      {/* A technician stays a technician (and an employee or partner never becomes one):
          the type is what decides where their money is recorded. */}
      {isContractor ? (
        <div className="flex flex-col gap-1.5">
          <span className={fieldLabel}>Tipo</span>
          <input type="hidden" name="type" value="contractor" />
          <span className="text-[13.5px] text-[var(--color-ink)]">Técnico externo</span>
        </div>
      ) : (
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
      )}

      {isContractor ? <TechnicianFields values={technicianFormValuesOf(person)} currency={currency} /> : null}

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
