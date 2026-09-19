"use client";

import { useActionState } from "react";
import type { Client } from "@/lib/dal";
import { updateClient, type EditClientState } from "./actions";
import { Field, FormActions, fieldInput, fieldLabel } from "@/components/FormField";

const initialState: EditClientState = { error: null };

export function EditClientForm({
  companyId,
  client,
}: {
  companyId: string;
  client: Client;
}) {
  const updateClientWithIds = updateClient.bind(null, companyId, client.id);
  const [state, formAction, pending] = useActionState(
    updateClientWithIds,
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
          defaultValue={client.name}
          className={fieldInput}
        />
      </Field>

      <Field label="RUT/RUC" htmlFor="tax_id">
        <input
          id="tax_id"
          name="tax_id"
          type="text"
          defaultValue={client.tax_id ?? ""}
          className={`${fieldInput} font-mono`}
        />
      </Field>

      <Field label="País" htmlFor="country">
        <input
          id="country"
          name="country"
          type="text"
          defaultValue={client.country ?? ""}
          className={fieldInput}
        />
      </Field>

      <Field label="Notas" htmlFor="notes">
        <textarea
          id="notes"
          name="notes"
          rows={3}
          defaultValue={client.notes ?? ""}
          className={fieldInput}
        />
      </Field>

      <div className="flex items-center gap-2">
        <input
          id="invoiceable"
          name="invoiceable"
          type="checkbox"
          defaultChecked={client.invoiceable}
          className="h-4 w-4 rounded border-[var(--color-hairline)]"
        />
        <label htmlFor="invoiceable" className={fieldLabel}>
          Se factura (desmarcar si es cliente &quot;sin factura&quot;)
        </label>
      </div>

      <div className="flex items-center gap-2">
        <input
          id="monthly"
          name="monthly"
          type="checkbox"
          defaultChecked={client.monthly}
          className="h-4 w-4 rounded border-[var(--color-hairline)]"
        />
        <label htmlFor="monthly" className={fieldLabel}>
          Servicio mensual
        </label>
      </div>

      <div className="flex items-center gap-2">
        <input
          id="active"
          name="active"
          type="checkbox"
          defaultChecked={client.active}
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

      <FormActions cancelHref={`/companies/${companyId}/clients`} pending={pending}>
        Guardar cambios
      </FormActions>
    </form>
  );
}
