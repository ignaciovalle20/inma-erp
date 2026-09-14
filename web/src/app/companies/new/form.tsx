"use client";

import { useActionState } from "react";
import { CURRENCIES } from "@/lib/currencies";
import { createCompany, type CreateCompanyState } from "./actions";
import { Field, FormActions, fieldInput } from "@/components/FormField";

const initialState: CreateCompanyState = { error: null };

export function NewCompanyForm() {
  const [state, formAction, pending] = useActionState(
    createCompany,
    initialState,
  );

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <Field label="Nombre" htmlFor="name">
        <input id="name" name="name" type="text" required className={fieldInput} />
      </Field>

      <Field label="País" htmlFor="country">
        <input id="country" name="country" type="text" className={fieldInput} />
      </Field>

      <Field label="RUT/RUC" htmlFor="tax_id">
        <input id="tax_id" name="tax_id" type="text" className={`${fieldInput} font-mono`} />
      </Field>

      <Field label="Moneda" htmlFor="currency">
        <select id="currency" name="currency" defaultValue="CLP" className={fieldInput}>
          {CURRENCIES.map((currency) => (
            <option key={currency} value={currency}>
              {currency}
            </option>
          ))}
        </select>
      </Field>

      {state.error ? (
        <p className="text-[13px] text-[var(--color-negative-ink)]" role="alert">
          {state.error}
        </p>
      ) : null}

      <FormActions cancelHref="/companies" pending={pending} pendingLabel="Creando…">
        Crear empresa
      </FormActions>
    </form>
  );
}
