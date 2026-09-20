"use client";

import { useActionState, useState } from "react";
import { createPersonnel, type CreatePersonnelState } from "./actions";
import { Field, FormActions, fieldInput } from "@/components/FormField";
import { EMPTY_TECHNICIAN_FORM } from "@/lib/technicians";
import { TechnicianFields } from "../technician-fields";

const initialState: CreatePersonnelState = {
  error: null,
  values: { name: "", type: "employee", ...EMPTY_TECHNICIAN_FORM },
};

export function NewPersonnelForm({ companyId }: { companyId: string }) {
  const createPersonnelWithCompany = createPersonnel.bind(null, companyId);
  const [state, formAction, pending] = useActionState(
    createPersonnelWithCompany,
    initialState,
  );
  const [type, setType] = useState(state.values.type);

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

      <Field label="Tipo" htmlFor="type">
        <select
          id="type"
          name="type"
          required
          value={type}
          onChange={(event) => setType(event.target.value)}
          className={fieldInput}
        >
          <option value="employee">Empleado</option>
          <option value="partner">Socio</option>
          <option value="contractor">Técnico externo</option>
        </select>
      </Field>

      {type === "contractor" ? <TechnicianFields values={state.values} /> : null}

      {state.error ? (
        <p className="text-[13px] text-[var(--color-negative-ink)]" role="alert">
          {state.error}
        </p>
      ) : null}

      <FormActions cancelHref={`/companies/${companyId}/personnel`} pending={pending}>
        Crear persona
      </FormActions>
    </form>
  );
}
