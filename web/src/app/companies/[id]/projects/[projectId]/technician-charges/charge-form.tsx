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
  BACKING_OPTIONS,
  ENTRY_MODES,
  FACTURA_VAT_RATE,
  RATE_FIELDS,
  backedChargeAmounts,
  chargeCost,
  defaultEntryMode,
  isEntryModeOf,
  parsePositiveAmount,
  parseWholePesos,
  percentLabel,
  vatRateLabel,
  withholdingRateFor,
  type Backing,
  type DefaultRates,
  type EnteredAs,
  type WithholdingRate,
} from "@/lib/technicians";

export type TechnicianOption = {
  id: string;
  name: string;
  payment_document: string | null;
  /** Chile: "Respaldo habitual", pre-fills the charge's backing. */
  default_backing: Backing;
  default_rates: DefaultRates;
};

// Local calendar date, not UTC (see costs/new/form.tsx).
function today(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

const CHIP = {
  idle: "border border-[var(--color-hairline)] bg-[var(--color-surface)] text-[var(--color-ink-2)] hover:border-[var(--color-border-hover)]",
  active: "border border-[var(--color-accent-soft-border)] bg-[var(--color-accent-soft)] text-[var(--color-accent-strong)]",
};

function Line({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span>{label}</span>
      <span className={`font-mono tabular-nums ${strong ? "font-semibold text-[var(--color-ink)]" : ""}`}>{value}</span>
    </div>
  );
}

/**
 * Loads (or corrects) what an external technician charges for this job.
 *
 * Chile (`backed`): each charge says what backs it -- factura, boleta de
 * honorarios or sin respaldo, pre-filled from the technician's ficha -- and
 * the amount is typed the way the document shows it (factura: neto or total
 * con IVA; boleta: líquido or bruto). The breakdown below shows the cost of
 * the job and what is paid to the technician as you type; the database
 * computes the same with the same formulas.
 *
 * Uruguay: one amount and "El monto incluye IVA", as before.
 */
export function ChargeForm({
  mode,
  companyId,
  projectId,
  chargeId,
  technicians,
  currency,
  vatRate,
  backed,
  withholdingRates = [],
  returnTo,
  initialValues,
}: {
  mode: "create" | "edit";
  companyId: string;
  projectId: string;
  chargeId?: string;
  technicians: TechnicianOption[];
  currency: string;
  vatRate: number;
  /** Chilean company: the charge records its backing. */
  backed: boolean;
  withholdingRates?: WithholdingRate[];
  /** Page to go back to after saving (edit only); the job when absent. */
  returnTo?: string;
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
      backing: "",
      entered_as: "",
    },
  };

  const action =
    mode === "edit" && chargeId
      ? updateTechnicianCharge.bind(null, companyId, projectId, chargeId)
      : createTechnicianCharge.bind(null, companyId, projectId);
  const [state, formAction, pending] = useActionState(action, initialState);

  const [personnelId, setPersonnelId] = useState(state.values.personnel_id);
  const [chargeDate, setChargeDate] = useState(state.values.charge_date);
  const [amount, setAmount] = useState(state.values.amount);
  const [vatIncluded, setVatIncluded] = useState(state.values.vat_included);
  const [vatTouched, setVatTouched] = useState(mode === "edit");
  const [backing, setBacking] = useState<Backing | "">(state.values.backing);
  const [enteredAs, setEnteredAs] = useState<EnteredAs | "">(state.values.entered_as);
  const [backingTouched, setBackingTouched] = useState(mode === "edit" || state.values.backing !== "");

  const technician = technicians.find((option) => option.id === personnelId);

  function chooseBacking(next: Backing) {
    setBacking(next);
    setEnteredAs((current) => (isEntryModeOf(next, current) ? current : defaultEntryMode(next)));
  }

  const rates = RATE_FIELDS.flatMap(({ key, label }) => {
    const value = technician?.default_rates[key];
    return value ? [`${label} ${formatAmount(value, currency)}`] : [];
  });

  // Read like the server reads it, so the preview shows what will be saved.
  const parsedAmount = backed ? parseWholePesos(amount) : parsePositiveAmount(amount);
  const withholdingRate = backing === "boleta" ? withholdingRateFor(withholdingRates, chargeDate) : null;
  const backedAmounts =
    backed && backing && enteredAs && parsedAmount.kind === "ok"
      ? backedChargeAmounts({ backing, enteredAs, value: parsedAmount.value, withholdingRate })
      : null;
  const cost =
    !backed && parsedAmount.kind === "ok"
      ? chargeCost({ amount: parsedAmount.value, vatIncluded, vatRate, currency })
      : null;
  const money = (value: number) => formatAmount(value, currency);

  const amountLabel = !backed
    ? `Monto que cobra (${currency})`
    : backing === "factura"
      ? enteredAs === "total"
        ? "Total con IVA (CLP)"
        : "Neto de la factura (CLP)"
      : backing === "boleta"
        ? enteredAs === "gross"
          ? "Bruto de la boleta (CLP)"
          : "Líquido a pagar (CLP)"
        : "Monto (CLP)";

  return (
    <form action={formAction} className="flex flex-col gap-4">
      {returnTo ? <input type="hidden" name="return_to" value={returnTo} /> : null}
      {mode === "edit" ? (
        <div className="flex flex-col gap-1.5">
          <span className="caps-label text-[var(--color-muted)]">
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
              const option = technicians.find((candidate) => candidate.id === next);
              if (!option) return;
              // The ficha's usual backing starts the charge, unless already chosen here.
              if (backed && !backingTouched) chooseBacking(option.default_backing);
              // A technician who issues facturas normally charges IVA on top: start there, unless already chosen.
              if (!backed && !vatTouched) setVatIncluded(option.payment_document === "factura");
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
          value={chargeDate}
          onChange={(event) => setChargeDate(event.target.value)}
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

      {backed ? (
        <Field label="Respaldo" htmlFor="backing" hint="Viene de la ficha del técnico; se puede cambiar en cada cargo.">
          <select
            id="backing"
            name="backing"
            required
            value={backing}
            onChange={(event) => {
              setBackingTouched(true);
              if (event.target.value) chooseBacking(event.target.value as Backing);
            }}
            className={fieldInput}
          >
            <option value="" disabled>
              Elegí el respaldo
            </option>
            {BACKING_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>
      ) : null}

      {backed && backing && ENTRY_MODES[backing].length > 1 ? (
        <div className="flex flex-col gap-1.5">
          <span className="caps-label text-[var(--color-muted)]">Ingresás el monto como</span>
          <div className="flex gap-1.5" role="radiogroup" aria-label="Ingresás el monto como">
            {ENTRY_MODES[backing].map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={enteredAs === option.value}
                onClick={() => setEnteredAs(option.value)}
                className={`rounded-lg px-3 py-1.5 text-[12.5px] font-medium ${
                  enteredAs === option.value ? CHIP.active : CHIP.idle
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      {backed ? <input type="hidden" name="entered_as" value={enteredAs} /> : null}

      <Field
        label={amountLabel}
        htmlFor="amount"
        hint={rates.length > 0 ? `Tarifas habituales: ${rates.join(" · ")}` : undefined}
      >
        <AmountInput
          id="amount"
          name="amount"
          maxDecimals={backed ? 0 : currencyDecimals(currency)}
          required
          value={amount}
          onValueChange={setAmount}
          className={`${fieldInput} font-mono`}
        />
      </Field>

      {!backed ? (
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
      ) : null}

      <div
        data-testid="charge-breakdown"
        className="flex flex-col gap-1 rounded-[10px] border border-[var(--color-hairline)] bg-[var(--color-canvas)] px-3 py-2.5 text-[12.5px] text-[var(--color-ink-2)]"
      >
        {parsedAmount.kind === "invalid" ? (
          <span className="text-[var(--color-negative-ink)]">Monto inválido {parsedAmount.reason}</span>
        ) : backed ? (
          !backing ? (
            "Elegí el respaldo para ver el desglose."
          ) : backing === "boleta" && withholdingRate === null ? (
            <span className="text-[var(--color-negative-ink)]">
              No hay tasa de retención de boletas para {chargeDate.slice(0, 4) || "esa fecha"}.
            </span>
          ) : backedAmounts === null ? (
            "Cargá el monto para ver el desglose."
          ) : backing === "factura" ? (
            <>
              <Line label="Neto" value={money(backedAmounts.cost)} />
              <Line label={`IVA ${vatRateLabel(FACTURA_VAT_RATE)}`} value={money(backedAmounts.vat)} />
              <Line label="Total" value={money(backedAmounts.payable)} />
              <span className="mt-1 border-t border-[var(--color-hairline)] pt-1">
                Costo del trabajo <strong className="font-mono">{money(backedAmounts.cost)}</strong> · A pagar al
                técnico <strong className="font-mono">{money(backedAmounts.payable)}</strong>
              </span>
            </>
          ) : backing === "boleta" ? (
            <>
              <Line label="Bruto" value={money(backedAmounts.cost)} />
              <Line
                label={`Retención ${percentLabel(backedAmounts.withholdingRate ?? 0)}`}
                value={money(backedAmounts.withholding)}
              />
              <Line label="Líquido" value={money(backedAmounts.payable)} />
              <span className="mt-1 border-t border-[var(--color-hairline)] pt-1">
                Costo del trabajo <strong className="font-mono">{money(backedAmounts.cost)}</strong> · A pagar al
                técnico <strong className="font-mono">{money(backedAmounts.payable)}</strong>. La retención la pagás
                en tu declaración: no se le debe al técnico.
              </span>
            </>
          ) : (
            <span>
              Costo del trabajo y a pagar al técnico: <strong className="font-mono">{money(backedAmounts.cost)}</strong>
              . Sin documento que vincular.
            </span>
          )
        ) : cost === null ? (
          "Cargá el monto para ver cuánto le cuesta el trabajo."
        ) : vatIncluded ? (
          <span>
            Costo del trabajo (sin IVA):{" "}
            <strong className="font-mono">{money(cost.net)}</strong> · IVA{" "}
            <span className="font-mono">{money(cost.tax)}</span> (no es costo) · A pagar al técnico:{" "}
            <span className="font-mono">{money(cost.total)}</span>
          </span>
        ) : (
          <span>
            Costo del trabajo: <strong className="font-mono">{money(cost.net)}</strong> (sin IVA aparte) · A pagar
            al técnico: <span className="font-mono">{money(cost.total)}</span>
          </span>
        )}
      </div>

      {state.error ? (
        <p className="text-[13px] text-[var(--color-negative-ink)]" role="alert">
          {state.error}
        </p>
      ) : null}

      <FormActions cancelHref={returnTo ?? `/companies/${companyId}/projects/${projectId}`} pending={pending}>
        {mode === "edit" ? "Guardar cambios" : "Registrar cargo"}
      </FormActions>
    </form>
  );
}
