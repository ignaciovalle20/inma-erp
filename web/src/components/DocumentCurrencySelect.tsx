"use client";

/**
 * The currency of a sale or cost, by the company's configuration
 * (lib/companyConfig.ts), the same rule recurring services follow:
 *  - one currency (Chile: CLP): shown, never asked, sent as a hidden field;
 *  - several (Uruguay: USD or UYU): a required choice, no default.
 * The server re-applies the rule (resolveDocumentCurrency).
 */
export function DocumentCurrencySelect({
  currencies,
  value,
  onChange,
  className,
  id = "currency",
}: {
  /** The currencies allowed (the document's own one included when editing). */
  currencies: string[];
  value: string;
  onChange: (value: string) => void;
  className: string;
  id?: string;
}) {
  if (currencies.length === 1) {
    return (
      <>
        <input type="hidden" name="currency" value={currencies[0]} />
        <p id={id} className="flex min-h-[38px] items-center text-[13.5px] text-[var(--color-ink-2)]">
          {currencies[0]} <span className="ml-1.5 text-[12px] text-[var(--color-muted)]">(única moneda de la empresa)</span>
        </p>
      </>
    );
  }

  return (
    <select
      id={id}
      name="currency"
      required
      value={currencies.includes(value) ? value : ""}
      onChange={(event) => onChange(event.target.value)}
      className={className}
    >
      <option value="" disabled>
        Elegí {currencies.join(" o ")}
      </option>
      {currencies.map((currency) => (
        <option key={currency} value={currency}>
          {currency}
        </option>
      ))}
    </select>
  );
}
