"use client";

import { useActionState } from "react";
import { createManualSale, type ManualSaleState } from "./actions";
import { Field, FormActions, fieldInput } from "@/components/FormField";
import { AmountInput } from "@/components/AmountInput";
import { currencyDecimals } from "@/lib/currencies";

export function ManualSaleForm({
  companyId,
  projectId,
  currency,
}: {
  companyId: string;
  projectId: string;
  currency: string;
}) {
  const initialState: ManualSaleState = {
    error: null,
    values: {
      document_date: new Date().toISOString().slice(0, 10),
      net_amount: "",
      tax_amount: "",
      description: "",
    },
  };

  const [state, formAction, pending] = useActionState(
    createManualSale.bind(null, companyId, projectId),
    initialState,
  );

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <Field label="Fecha" htmlFor="document_date">
        <input
          id="document_date"
          name="document_date"
          type="date"
          required
          defaultValue={state.values.document_date}
          className={`${fieldInput} font-mono`}
        />
      </Field>

      <Field label={`Monto neto (${currency})`} htmlFor="net_amount">
        <AmountInput
          id="net_amount"
          name="net_amount"
          maxDecimals={currencyDecimals(currency)}
          required
          defaultValue={state.values.net_amount}
          className={`${fieldInput} font-mono`}
        />
      </Field>

      <Field label="IVA (opcional)" htmlFor="tax_amount" hint="Déjalo vacío si la venta no lleva IVA.">
        <AmountInput
          id="tax_amount"
          name="tax_amount"
          maxDecimals={currencyDecimals(currency)}
          defaultValue={state.values.tax_amount}
          className={`${fieldInput} font-mono`}
        />
      </Field>

      <Field label="Descripción (opcional)" htmlFor="description">
        <input
          id="description"
          name="description"
          type="text"
          defaultValue={state.values.description}
          className={fieldInput}
        />
      </Field>

      <p className="text-[12px] text-[var(--color-muted)]">
        Queda como cobro pendiente. Después la marcás pagada, con fecha y medio de pago, desde Ventas → Pendientes.
      </p>

      {state.error ? (
        <p className="text-[13px] text-[var(--color-negative-ink)]" role="alert">
          {state.error}
        </p>
      ) : null}

      <FormActions cancelHref={`/companies/${companyId}/projects/${projectId}`} pending={pending}>
        Registrar venta
      </FormActions>
    </form>
  );
}
