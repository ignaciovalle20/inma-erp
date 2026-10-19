"use client";

import { useState } from "react";
import { Field, fieldInput } from "@/components/FormField";
import { AmountInput } from "@/components/AmountInput";
import { Money } from "@/components/Money";
import { currencyDecimals } from "@/lib/currencies";
import { PRICING_MODES, PRICING_MODE_LABELS, type PricingMode } from "@/lib/recurringServiceTypes";

/**
 * Pricing of a recurring service: a fixed reference amount (optional), or
 * a unit price x default quantity (MS licenses). The reference only
 * projects and pre-fills each period's expected amount; what was billed
 * comes from the invoices allocated to the period.
 */
export function PricingFields({
  currency,
  defaults,
}: {
  currency: string;
  defaults: {
    pricing_mode: string;
    reference_amount: string | number | null;
    unit_price: string | number | null;
    default_quantity: string | number | null;
  };
}) {
  const [mode, setMode] = useState<PricingMode>(defaults.pricing_mode === "per_unit" ? "per_unit" : "fixed");
  const [unitPrice, setUnitPrice] = useState(String(defaults.unit_price ?? ""));
  const [quantity, setQuantity] = useState(String(defaults.default_quantity ?? ""));

  const reference = Number(unitPrice) * Number(quantity);

  return (
    <div className="flex flex-col gap-3">
      <Field label="Precio" htmlFor="pricing_mode">
        <select
          id="pricing_mode"
          name="pricing_mode"
          value={mode}
          onChange={(event) => setMode(event.target.value as PricingMode)}
          className={fieldInput}
        >
          {PRICING_MODES.map((value) => (
            <option key={value} value={value}>
              {PRICING_MODE_LABELS[value]}
            </option>
          ))}
        </select>
      </Field>

      {mode === "fixed" ? (
        <Field label="Monto referencial (opcional)" htmlFor="reference_amount">
          <AmountInput
            id="reference_amount"
            name="reference_amount"
            maxDecimals={currencyDecimals(currency)}
            defaultValue={defaults.reference_amount ?? ""}
            className={`${fieldInput} font-mono`}
          />
        </Field>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Precio unitario" htmlFor="unit_price">
            <AmountInput
              id="unit_price"
              name="unit_price"
              maxDecimals={4}
              required
              value={unitPrice}
              onValueChange={setUnitPrice}
              className={`${fieldInput} font-mono`}
            />
          </Field>
          <Field label="Cantidad por defecto" htmlFor="default_quantity">
            <input
              id="default_quantity"
              name="default_quantity"
              type="number"
              min={0}
              step="any"
              required
              value={quantity}
              onChange={(event) => setQuantity(event.target.value)}
              className={`${fieldInput} font-mono`}
            />
          </Field>
        </div>
      )}

      <p className="text-[11.5px] text-[var(--color-muted)]">
        {mode === "per_unit" ? (
          <>
            Referencial:{" "}
            {Number.isFinite(reference) && unitPrice && quantity ? (
              <Money value={reference} currency={currency || "CLP"} showCurrency={false} />
            ) : (
              "—"
            )}{" "}
            por período. La cantidad se puede cambiar en cada período.
          </>
        ) : (
          "Solo sirve para proyectar y pre-llenar cada período; lo facturado sale de las facturas asignadas."
        )}
      </p>
    </div>
  );
}
