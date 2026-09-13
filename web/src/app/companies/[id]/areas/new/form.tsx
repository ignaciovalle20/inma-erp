"use client";

import { useActionState } from "react";
import { createBusinessArea, type CreateBusinessAreaState } from "./actions";
import { Field, FormActions, fieldInput } from "@/components/FormField";

const initialState: CreateBusinessAreaState = {
  error: null,
  values: { name: "" },
};

export function NewBusinessAreaForm({ companyId }: { companyId: string }) {
  const createBusinessAreaWithCompany = createBusinessArea.bind(
    null,
    companyId,
  );
  const [state, formAction, pending] = useActionState(
    createBusinessAreaWithCompany,
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

      {state.error ? (
        <p className="text-[13px] text-[var(--color-negative-ink)]" role="alert">
          {state.error}
        </p>
      ) : null}

      <FormActions cancelHref={`/companies/${companyId}/areas`} pending={pending}>
        Crear área
      </FormActions>
    </form>
  );
}
