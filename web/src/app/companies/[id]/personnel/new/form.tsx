"use client";

import { useActionState } from "react";
import { createPersonnel, type CreatePersonnelState } from "./actions";
import { Field, FormActions, fieldInput } from "@/components/FormField";

const initialState: CreatePersonnelState = {
  error: null,
  values: { name: "", type: "employee" },
};

export function NewPersonnelForm({ companyId }: { companyId: string }) {
  const createPersonnelWithCompany = createPersonnel.bind(null, companyId);
  const [state, formAction, pending] = useActionState(
    createPersonnelWithCompany,
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

      <Field label="Tipo" htmlFor="type">
        <select
          id="type"
          name="type"
          required
          defaultValue={state.values.type}
          className={fieldInput}
        >
          <option value="employee">Empleado</option>
          <option value="partner">Socio</option>
        </select>
      </Field>

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
