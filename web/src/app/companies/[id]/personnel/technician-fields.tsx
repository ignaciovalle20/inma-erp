"use client";

import { Field, fieldInput, fieldLabel } from "@/components/FormField";
import { PAYMENT_DOCUMENTS, RATE_FIELDS, type TechnicianFormValues } from "@/lib/technicians";

/**
 * The ficha of an external technician (docs/plan-sistema-v3.md, F1): tax id,
 * the document they issue, their usual rates and how to pay them. Rendered by
 * the new and edit forms only for the "Técnico externo" type.
 */
export function TechnicianFields({ values }: { values: TechnicianFormValues }) {
  return (
    <>
      <Field label="RUT / documento" htmlFor="tax_id">
        <input id="tax_id" name="tax_id" type="text" defaultValue={values.tax_id} className={fieldInput} />
      </Field>

      <Field
        label="Documento que emite"
        htmlFor="payment_document"
        hint="Con factura, el monto que te cobra suele incluir IVA; con boleta de honorarios, no."
      >
        <select
          id="payment_document"
          name="payment_document"
          defaultValue={values.payment_document}
          className={fieldInput}
        >
          <option value="">Sin definir</option>
          {PAYMENT_DOCUMENTS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </Field>

      <div className="flex flex-col gap-1.5">
        <span className={fieldLabel}>Tarifas habituales (opcional)</span>
        <div className="grid grid-cols-3 gap-3">
          {RATE_FIELDS.map(({ key, label }) => {
            const name = `rate_${key}` as const;
            return (
              <div key={key} className="flex flex-col gap-1">
                <label htmlFor={name} className="text-[11.5px] text-[var(--color-muted)]">
                  {label}
                </label>
                <input
                  id={name}
                  name={name}
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  min="0"
                  defaultValue={values[name]}
                  className={`${fieldInput} font-mono`}
                />
              </div>
            );
          })}
        </div>
      </div>

      <Field
        label="Datos de pago"
        htmlFor="payment_details"
        hint="Banco, tipo y número de cuenta, titular, correo para el comprobante…"
      >
        <textarea
          id="payment_details"
          name="payment_details"
          rows={3}
          defaultValue={values.payment_details}
          className={fieldInput}
        />
      </Field>
    </>
  );
}
