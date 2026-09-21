"use client";

import { useActionState, useState } from "react";
import { recordTechnicianPayment, type PaymentFormState } from "./actions";
import { Field, fieldInput } from "@/components/FormField";
import { Button } from "@/components/Button";
import { formatAmount } from "@/components/Money";
import { distributeOldestFirst, type Application } from "@/lib/technicians";

export type OpenCharge = {
  id: string;
  charge_date: string;
  project_name: string;
  description: string | null;
  outstanding: number;
};

const initialState: PaymentFormState = { error: null, saved: false };

// Local calendar date, not UTC (see costs/new/form.tsx).
function today(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

const cents = (value: number) => Math.round(value * 100);

/**
 * Registers a payment ("abono") to the technician. Type the amount and it is
 * split over the charges still owed, oldest first; or edit how much goes to
 * each charge and the amount follows. A payment can only cover charges that
 * exist, so what does not fit is shown and the button stays off.
 */
export function PaymentForm({
  companyId,
  personnelId,
  currency,
  openCharges,
}: {
  companyId: string;
  personnelId: string;
  currency: string;
  openCharges: OpenCharge[];
}) {
  const [state, formAction, pending] = useActionState(
    recordTechnicianPayment.bind(null, companyId, personnelId),
    initialState,
  );

  const [amount, setAmount] = useState("");
  const [allocations, setAllocations] = useState<Record<string, string>>({});

  const totalOwed = openCharges.reduce((sum, charge) => sum + cents(charge.outstanding), 0) / 100;

  function fill(next: string) {
    setAmount(next);
    const value = Number(next);
    if (next.trim() === "" || !Number.isFinite(value) || value <= 0) {
      setAllocations({});
      return;
    }
    const { applications } = distributeOldestFirst(
      openCharges.map((charge) => ({
        id: charge.id,
        charge_date: charge.charge_date,
        outstanding: charge.outstanding,
      })),
      value,
    );
    setAllocations(Object.fromEntries(applications.map((a) => [a.chargeId, String(a.amount)])));
  }

  function edit(chargeId: string, next: string) {
    const updated = { ...allocations, [chargeId]: next };
    setAllocations(updated);
    const sum = Object.values(updated).reduce((total, value) => {
      const n = Number(value);
      return Number.isFinite(n) && n > 0 ? total + cents(n) : total;
    }, 0);
    setAmount(sum > 0 ? String(sum / 100) : "");
  }

  const applications: Application[] = openCharges.flatMap((charge) => {
    const value = Number(allocations[charge.id]);
    return Number.isFinite(value) && value > 0 ? [{ chargeId: charge.id, amount: value }] : [];
  });

  const applied = applications.reduce((sum, application) => sum + cents(application.amount), 0);
  const typed = cents(Number(amount) || 0);
  const unapplied = typed - applied;
  const overCharge = openCharges.find(
    (charge) => cents(Number(allocations[charge.id]) || 0) > cents(charge.outstanding),
  );
  const canSubmit = applications.length > 0 && unapplied === 0 && !overCharge;

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Fecha" htmlFor="payment_date">
          <input
            id="payment_date"
            name="payment_date"
            type="date"
            required
            defaultValue={today()}
            className={`${fieldInput} font-mono`}
          />
        </Field>

        <Field label={`Monto del pago (${currency})`} htmlFor="amount">
          <div className="flex gap-2">
            <input
              id="amount"
              name="amount"
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0"
              required
              value={amount}
              onChange={(event) => fill(event.target.value)}
              className={`${fieldInput} min-w-0 flex-1 font-mono`}
            />
            <Button type="button" variant="secondary" onClick={() => fill(String(totalOwed))}>
              Pagar todo
            </Button>
          </div>
        </Field>

        <Field label="Medio de pago (opcional)" htmlFor="method">
          <input
            id="method"
            name="method"
            type="text"
            list="payment-methods"
            className={fieldInput}
          />
          <datalist id="payment-methods">
            <option value="Transferencia" />
            <option value="Efectivo" />
            <option value="Cheque" />
          </datalist>
        </Field>

        <Field label="Notas (opcional)" htmlFor="notes">
          <input id="notes" name="notes" type="text" className={fieldInput} />
        </Field>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--color-muted)]">
          A qué cargos se aplica
        </span>
        <div className="overflow-hidden rounded-[10px] border border-[var(--color-hairline)]">
          {openCharges.map((charge) => (
            <div
              key={charge.id}
              className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-row)] px-3 py-2 last:border-b-0"
            >
              <div className="flex min-w-0 flex-col">
                <span className="truncate text-[13px] text-[var(--color-ink)]">
                  {charge.project_name}
                  {charge.description ? ` — ${charge.description}` : ""}
                </span>
                <span className="text-[11.5px] text-[var(--color-muted)]">
                  {charge.charge_date} · falta <span className="font-mono">{formatAmount(charge.outstanding, currency)}</span>
                </span>
              </div>
              <input
                aria-label={`Aplicar a ${charge.project_name}`}
                type="number"
                inputMode="decimal"
                step="0.01"
                min="0"
                max={charge.outstanding}
                value={allocations[charge.id] ?? ""}
                onChange={(event) => edit(charge.id, event.target.value)}
                placeholder="0"
                className={`${fieldInput} w-36 font-mono`}
              />
            </div>
          ))}
        </div>
        <input type="hidden" name="applications" value={JSON.stringify(applications)} />

        <p className="text-[12px] text-[var(--color-muted)]">
          {typed === 0
            ? "Escribí el monto: se reparte primero en los cargos más antiguos, y podés ajustarlo."
            : unapplied > 0
              ? `Sobran ${formatAmount(unapplied / 100, currency)}: un pago solo puede cubrir cargos que existen (no hay anticipos).`
              : overCharge
                ? "Hay un cargo con más de lo que falta pagarle."
                : `Aplicado: ${formatAmount(applied / 100, currency)}`}
        </p>
      </div>

      {state.error ? (
        <p className="text-[13px] text-[var(--color-negative-ink)]" role="alert">
          {state.error}
        </p>
      ) : null}
      {state.saved ? (
        <p className="text-[13px] text-[var(--color-accent-strong)]" role="status">
          Pago registrado.
        </p>
      ) : null}

      <div>
        <Button type="submit" pending={pending} pendingLabel="Registrando…" disabled={!canSubmit}>
          Registrar pago
        </Button>
      </div>
    </form>
  );
}
