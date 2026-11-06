"use client";

import { Field, fieldInput } from "@/components/FormField";
import type { ProjectCurrencyChoice } from "@/lib/projectCurrency";

/**
 * "Moneda del trabajo" (lib/projectCurrency.ts): a selector when the
 * company has two currencies (local by default), only a hidden field when it
 * has one. `lockedReason` shows the currency read-only with the reason (a
 * job with movements cannot change it); the value is still sent, unchanged.
 */
export function ProjectCurrencyField({
  choice,
  value,
  onChange,
  lockedReason,
}: {
  choice: ProjectCurrencyChoice;
  value: string;
  onChange: (value: string) => void;
  lockedReason?: string | null;
}) {
  if (!choice.showSelector) {
    return <input type="hidden" name="currency" value={choice.currencies[0]} />;
  }

  if (lockedReason) {
    return (
      <Field label="Moneda del trabajo" htmlFor="currency" hint={lockedReason}>
        <input type="hidden" name="currency" value={value} />
        <select id="currency" disabled value={value} className={`${fieldInput} font-mono`}>
          <option value={value}>{value}</option>
        </select>
      </Field>
    );
  }

  return (
    <Field
      label="Moneda del trabajo"
      htmlFor="currency"
      hint="La cotización y el presupuesto de costo van en esta moneda; los reportes la convierten a la moneda local."
    >
      <select
        id="currency"
        name="currency"
        required
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={`${fieldInput} font-mono`}
      >
        {choice.currencies.map((currency) => (
          <option key={currency} value={currency}>
            {currency}
          </option>
        ))}
      </select>
    </Field>
  );
}
