"use client";

import { useActionState, useState } from "react";
import {
  createTechnicianCharge,
  updateTechnicianCharge,
  type ChargeFormState,
} from "./actions";
import { Field, FormActions, fieldInput } from "@/components/FormField";
import { formatAmount } from "@/components/Money";
import { AmountInput } from "@/components/AmountInput";
import { currencyDecimals } from "@/lib/currencies";
import {
  RATE_FIELDS,
  chargeCost,
  parsePositiveAmount,
  vatRateLabel,
  type DefaultRates,
} from "@/lib/technicians";

export type TechnicianOption = {
  id: string;
  name: string;
  payment_document: string | null;
  default_rates: DefaultRates;
};

// Local calendar date, not UTC (see costs/new/form.tsx).
function today(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/**
 * Loads (or corrects) what an external technician charges for this job. The
 * cost the job carries is the amount without IVA when the amount includes it;
 * the preview shows it as you type, and the database computes the real one.
 */
export function ChargeForm({
  mode,
  companyId,
  projectId,
  chargeId,
  technicians,
  currency,
  vatRate,
  initialValues,
}: {
  mode: "create" | "edit";
  companyId: string;
  projectId: string;
  chargeId?: string;
  technicians: TechnicianOption[];
  currency: string;
  vatRate: number;
  initialValues?: ChargeFormState["values"];
}) {
  const initialState: ChargeFormState = {
    error: null,
    values: initialValues ?? {
      personnel_id: "",
      charge_date: today(),
      description: "",
      amount: "",
      vat_included: false,
    },
  };

  const action =
    mode === "edit" && chargeId
      ? updateTechnicianCharge.bind(null, companyId, projectId, chargeId)
      : createTechnicianCharge.bind(null, companyId, projectId);
  const [state, formAction, pending] = useActionState(action, initialState);

  const [personnelId, setPersonnelId] = useState(state.values.personnel_id);
  const [amount, setAmount] = useState(state.values.amount);
  const [vatIncluded, setVatIncluded] = useState(state.values.vat_included);
  const [vatTouched, setVatTouched] = useState(mode === "edit");

  const technician = technicians.find((option) => option.id === personnelId);
  // Read like the server reads it, so the preview shows what will be saved.
  const parsedAmount = parsePositiveAmount(amount);
  const cost =
    parsedAmount.kind === "ok"
      ? chargeCost({ amount: parsedAmount.value, vatIncluded, vatRate, currency })
      : null;

  const rates = RATE_FIELDS.flatMap(({ key, label }) => {
    const value = technician?.default_rates[key];
    return value ? [`${label} ${formatAmount(value, currency)}`] : [];
  });

  return (
    <form action={formAction} className="flex flex-col gap-4">
      {mode === "edit" ? (
        <div className="flex flex-col gap-1.5">
          <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--color-muted)]">
            Técnico
          </span>
          <span className="text-[13.5px] text-[var(--color-ink)]">{technician?.name ?? "—"}</span>
          <input type="hidden" name="personnel_id" value={personnelId} />
        </div>
      ) : (
        <Field label="Técnico" htmlFor="personnel_id">
          <select
            id="personnel_id"
            name="personnel_id"
            required
            value={personnelId}
            onChange={(event) => {
              const next = event.target.value;
              setPersonnelId(next);
              // A technician who issues facturas normally charges IVA on top: start there, unless already chosen.
              const option = technicians.find((candidate) => candidate.id === next);
              if (!vatTouched && option) setVatIncluded(option.payment_document === "factura");
            }}
            className={fieldInput}
          >
            <option value="">Elegí un técnico</option>
            {technicians.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
          </select>
        </Field>
      )}

      <Field label="Fecha" htmlFor="charge_date">
        <input
          id="charge_date"
          name="charge_date"
          type="date"
          required
          defaultValue={state.values.charge_date}
          className={`${fieldInput} font-mono`}
        />
      </Field>

      <Field label="Descripción (opcional)" htmlFor="description" hint="Qué hizo: visita, instalación de puntos de red…">
        <input
          id="description"
          name="description"
          type="text"
          defaultValue={state.values.description}
          className={fieldInput}
        />
      </Field>

      <Field
        label={`Monto que cobra (${currency})`}
        htmlFor="amount"
        hint={rates.length > 0 ? `Tarifas habituales: ${rates.join(" · ")}` : undefined}
      >
        <AmountInput
          id="amount"
          name="amount"
          maxDecimals={currencyDecimals(currency)}
          required
          value={amount}
          onValueChange={setAmount}
          className={`${fieldInput} font-mono`}
        />
      </Field>

      <div className="flex items-center gap-2">
        <input
          id="vat_included"
          name="vat_included"
          type="checkbox"
          checked={vatIncluded}
          onChange={(event) => {
            setVatIncluded(event.target.checked);
            setVatTouched(true);
          }}
          className="h-4 w-4 rounded border-[var(--color-hairline)]"
        />
        <label htmlFor="vat_included" className="text-[13px] text-[var(--color-ink)]">
          El monto incluye IVA ({vatRateLabel(vatRate)})
        </label>
      </div>

      <div className="rounded-[10px] border border-[var(--color-hairline)] bg-[var(--color-canvas)] px-3 py-2.5 text-[12.5px] text-[var(--color-ink-2)]">
        {parsedAmount.kind === "invalid" ? (
          <span className="text-[var(--color-negative-ink)]">Monto inválido {parsedAmount.reason}</span>
        ) : cost === null ? (
          "Cargá el monto para ver cuánto le cuesta el trabajo."
        ) : vatIncluded ? (
          <>
            Costo del trabajo (sin IVA):{" "}
            <strong className="font-mono">{formatAmount(cost.net, currency)}</strong> · IVA{" "}
            <span className="font-mono">{formatAmount(cost.tax, currency)}</span> (no es costo) · A pagar al técnico:{" "}
            <span className="font-mono">{formatAmount(cost.total, currency)}</span>
          </>
        ) : (
          <>
            Costo del trabajo: <strong className="font-mono">{formatAmount(cost.net, currency)}</strong> (sin IVA
            aparte) · A pagar al técnico: <span className="font-mono">{formatAmount(cost.total, currency)}</span>
          </>
        )}
      </div>

      {state.error ? (
        <p className="text-[13px] text-[var(--color-negative-ink)]" role="alert">
          {state.error}
        </p>
      ) : null}

      <FormActions cancelHref={`/companies/${companyId}/projects/${projectId}`} pending={pending}>
        {mode === "edit" ? "Guardar cambios" : "Registrar cargo"}
      </FormActions>
    </form>
  );
}
