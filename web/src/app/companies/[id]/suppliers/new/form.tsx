"use client";

import { useActionState } from "react";
import { createSupplier, type CreateSupplierState } from "./actions";
import { Field, FormActions, fieldInput } from "@/components/FormField";

const initialState: CreateSupplierState = {
  error: null,
  warning: null,
  values: { name: "", tax_id: "", country: "", notes: "" },
};

export function NewSupplierForm({ companyId }: { companyId: string }) {
  const createSupplierWithCompany = createSupplier.bind(null, companyId);
  const [state, formAction, pending] = useActionState(
    createSupplierWithCompany,
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

      <Field label="RUT/RUC" htmlFor="tax_id">
        <input
          id="tax_id"
          name="tax_id"
          type="text"
          defaultValue={state.values.tax_id}
          className={`${fieldInput} font-mono`}
        />
      </Field>

      <Field label="País" htmlFor="country">
        <input
          id="country"
          name="country"
          type="text"
          defaultValue={state.values.country}
          className={fieldInput}
        />
      </Field>

      <Field label="Notas" htmlFor="notes">
        <textarea
          id="notes"
          name="notes"
          rows={3}
          defaultValue={state.values.notes}
          className={fieldInput}
        />
      </Field>

      {state.warning ? (
        <div
          role="alert"
          className="flex flex-col gap-2 rounded-lg border border-[var(--color-warning-soft-border)] bg-[var(--color-warning-soft)] px-3 py-2.5 text-[13px] text-[var(--color-warning-ink)]"
        >
          <p>
            Este nombre es muy similar a un proveedor existente:{" "}
            {state.warning.matches.join(", ")}. Podés guardar igual si es un
            proveedor distinto.
          </p>
          <input type="hidden" name="confirmed" value="true" />
          <input
            type="hidden"
            name="confirmedName"
            value={state.warning.checkedName}
          />
        </div>
      ) : null}

      {state.error ? (
        <p className="text-[13px] text-[var(--color-negative-ink)]" role="alert">
          {state.error}
        </p>
      ) : null}

      <FormActions
        cancelHref={`/companies/${companyId}/suppliers`}
        pending={pending}
      >
        {state.warning ? "Guardar igual" : "Crear proveedor"}
      </FormActions>
    </form>
  );
}
