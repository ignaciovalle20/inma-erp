"use client";

import { useActionState } from "react";
import type { Company } from "@/lib/dal";
import { CURRENCIES } from "@/lib/currencies";
import { updateCompany, type EditCompanyState } from "./actions";
import { Field, FormActions, fieldInput, fieldLabel } from "@/components/FormField";

const initialState: EditCompanyState = { error: null };

export function EditCompanyForm({
  companyId,
  company,
}: {
  companyId: string;
  company: Company;
}) {
  const updateCompanyWithId = updateCompany.bind(null, companyId);
  const [state, formAction, pending] = useActionState(
    updateCompanyWithId,
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
          defaultValue={company.name}
          className={fieldInput}
        />
      </Field>

      <Field label="País" htmlFor="country">
        <input
          id="country"
          name="country"
          type="text"
          defaultValue={company.country ?? ""}
          className={fieldInput}
        />
      </Field>

      <Field label="RUT/RUC" htmlFor="tax_id">
        <input
          id="tax_id"
          name="tax_id"
          type="text"
          defaultValue={company.tax_id ?? ""}
          className={`${fieldInput} font-mono`}
        />
      </Field>

      <Field label="Moneda" htmlFor="currency">
        <select
          id="currency"
          name="currency"
          defaultValue={company.currency}
          className={fieldInput}
        >
          {CURRENCIES.map((currency) => (
            <option key={currency} value={currency}>
              {currency}
            </option>
          ))}
        </select>
      </Field>

      <div className="flex items-center gap-2">
        <input
          id="active"
          name="active"
          type="checkbox"
          defaultChecked={company.active}
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

      <FormActions cancelHref="/companies" pending={pending}>
        Guardar cambios
      </FormActions>
    </form>
  );
}
