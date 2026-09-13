"use client";

import { useActionState } from "react";
import type { Supplier } from "@/lib/dal";
import { updateSupplier, type EditSupplierState } from "./actions";
import { Field, FormActions, fieldInput, fieldLabel } from "@/components/FormField";

const initialState: EditSupplierState = { error: null };

export function EditSupplierForm({
  companyId,
  supplier,
}: {
  companyId: string;
  supplier: Supplier;
}) {
  const updateSupplierWithIds = updateSupplier.bind(
    null,
    companyId,
    supplier.id,
  );
  const [state, formAction, pending] = useActionState(
    updateSupplierWithIds,
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
          defaultValue={supplier.name}
          className={fieldInput}
        />
      </Field>

      <Field label="RUT/RUC" htmlFor="tax_id">
        <input
          id="tax_id"
          name="tax_id"
          type="text"
          defaultValue={supplier.tax_id ?? ""}
          className={`${fieldInput} font-mono`}
        />
      </Field>

      <Field label="País" htmlFor="country">
        <input
          id="country"
          name="country"
          type="text"
          defaultValue={supplier.country ?? ""}
          className={fieldInput}
        />
      </Field>

      <Field label="Notas" htmlFor="notes">
        <textarea
          id="notes"
          name="notes"
          rows={3}
          defaultValue={supplier.notes ?? ""}
          className={fieldInput}
        />
      </Field>

      <div className="flex items-center gap-2">
        <input
          id="active"
          name="active"
          type="checkbox"
          defaultChecked={supplier.active}
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

      <FormActions
        cancelHref={`/companies/${companyId}/suppliers`}
        pending={pending}
      >
        Guardar cambios
      </FormActions>
    </form>
  );
}
