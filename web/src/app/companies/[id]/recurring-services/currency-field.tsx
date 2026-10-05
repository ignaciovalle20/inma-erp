"use client";

import { Field, fieldInput } from "@/components/FormField";
import {
  SERVICE_COUNTRY_LABELS,
  currenciesForCountry,
  type ServiceCountry,
} from "@/lib/recurringServiceTypes";

/**
 * Currency of a recurring service, by the active company's country
 * (never asked): Chile shows a fixed "Chile · CLP" with no selector;
 * Uruguay asks USD/UYU with no default, required; a company with no
 * country keeps the old three-way choice. The server re-applies the
 * same rule (resolveServiceCurrency), so the hidden CLP is only a
 * convenience.
 */
export function CurrencyField({
  country,
  value,
  onChange,
}: {
  country: ServiceCountry | null;
  value: string;
  onChange: (value: string) => void;
}) {
  if (country === "CL") {
    return (
      <Field label="Moneda" htmlFor="currency">
        <input type="hidden" name="currency" value="CLP" />
        <p
          id="currency"
          className="flex min-h-[38px] items-center text-[13.5px] text-[var(--color-ink-2)]"
        >
          {`${SERVICE_COUNTRY_LABELS.CL} · CLP`}
        </p>
      </Field>
    );
  }

  const options = currenciesForCountry(country);
  return (
    <Field label="Moneda" htmlFor="currency">
      <select
        id="currency"
        name="currency"
        required
        value={options.includes(value) ? value : ""}
        onChange={(event) => onChange(event.target.value)}
        className={fieldInput}
      >
        <option value="" disabled>
          Elegí moneda
        </option>
        {options.map((currency) => (
          <option key={currency} value={currency}>
            {currency}
          </option>
        ))}
      </select>
    </Field>
  );
}
