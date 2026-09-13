"use client";

import { useActionState } from "react";
import type { BusinessArea } from "@/lib/dal";
import { updateBusinessArea, type EditBusinessAreaState } from "./actions";
import { Field, FormActions, fieldInput, fieldLabel } from "@/components/FormField";

const initialState: EditBusinessAreaState = { error: null };

export function EditBusinessAreaForm({
  companyId,
  area,
}: {
  companyId: string;
  area: BusinessArea;
}) {
  const updateBusinessAreaWithIds = updateBusinessArea.bind(
    null,
    companyId,
    area.id,
  );
  const [state, formAction, pending] = useActionState(
    updateBusinessAreaWithIds,
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
          defaultValue={area.name}
          className={fieldInput}
        />
      </Field>

      <div className="flex items-center gap-2">
        <input
          id="active"
          name="active"
          type="checkbox"
          defaultChecked={area.active}
          className="h-4 w-4 rounded border-[var(--color-hairline)]"
        />
        <label htmlFor="active" className={fieldLabel}>
          Activa
        </label>
      </div>

      {state.error ? (
        <p className="text-[13px] text-[var(--color-negative-ink)]" role="alert">
          {state.error}
        </p>
      ) : null}

      <FormActions cancelHref={`/companies/${companyId}/areas`} pending={pending}>
        Guardar cambios
      </FormActions>
    </form>
  );
}
