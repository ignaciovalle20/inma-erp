"use client";

import { useActionState, useEffect, useState } from "react";
import { setPaymentStatusAction, type PaymentStatusActionState } from "./payment-actions";

/** The bulk form of the sales list; row checkboxes join it through the `form` attribute. */
export const BULK_PAYMENT_FORM_ID = "sales-payment-bulk";

const initialState: PaymentStatusActionState = { error: null, message: null };

function rowCheckboxes(): HTMLInputElement[] {
  return Array.from(
    document.querySelectorAll<HTMLInputElement>(`input[type="checkbox"][form="${BULK_PAYMENT_FORM_ID}"][name="ids"]`),
  );
}

const button =
  "inline-flex min-h-8 items-center whitespace-nowrap rounded-control border border-[var(--color-hairline)] bg-[var(--color-surface)] px-3 text-[12.5px] font-medium text-[var(--color-ink)] hover:border-[var(--color-border-hover)] disabled:opacity-50";

/**
 * "Marcar pagadas" / "Marcar impagas" for the sales ticked in the list, with
 * an optional payment date. Nothing more: the selection is the checkboxes.
 */
export function SalesBulkPaymentBar({ companyId }: { companyId: string }) {
  const [state, formAction, pending] = useActionState(
    setPaymentStatusAction.bind(null, companyId),
    initialState,
  );
  const [selected, setSelected] = useState(0);

  useEffect(() => {
    const update = () => setSelected(rowCheckboxes().filter((box) => box.checked).length);
    update();
    document.addEventListener("change", update);
    return () => document.removeEventListener("change", update);
  }, []);

  // A change that went through clears the selection.
  useEffect(() => {
    if (!state.message) return;
    for (const box of rowCheckboxes()) box.checked = false;
    const all = document.getElementById("sales-select-all") as HTMLInputElement | null;
    if (all) all.checked = false;
    // The counter listens to change events (see above).
    document.dispatchEvent(new Event("change"));
  }, [state]);

  return (
    <form
      id={BULK_PAYMENT_FORM_ID}
      action={formAction}
      className="surface-card flex flex-wrap items-center gap-2 px-3 py-2 text-[12.5px]"
    >
      <span className="font-medium text-[var(--color-ink-2)]">
        {selected === 0 ? "Seleccioná ventas para cambiar su estado de pago" : `${selected} seleccionada${selected === 1 ? "" : "s"}`}
      </span>
      <label className="flex items-center gap-1.5 text-[var(--color-muted)]">
        Fecha de pago (opcional)
        <input type="date" name="paid_at" className="control min-h-8 py-0" aria-label="Fecha de pago (opcional)" />
      </label>
      <button type="submit" name="status" value="pagado" disabled={pending || selected === 0} className={button}>
        Marcar pagadas
      </button>
      <button type="submit" name="status" value="impago" disabled={pending || selected === 0} className={button}>
        Marcar impagas
      </button>
      {state.error ? (
        <span role="alert" className="text-[var(--color-negative-ink)]">
          {state.error}
        </span>
      ) : state.message ? (
        <span role="status" className="text-[var(--color-accent-strong)]">
          {state.message}
        </span>
      ) : null}
    </form>
  );
}

/** Header checkbox: ticks or clears every row on the page. */
export function SelectAllSales() {
  return (
    <input
      id="sales-select-all"
      type="checkbox"
      aria-label="Seleccionar todas las ventas de la página"
      onChange={(event) => {
        for (const box of rowCheckboxes()) box.checked = event.currentTarget.checked;
        document.dispatchEvent(new Event("change"));
      }}
    />
  );
}

/** One-click change from the row: Impaga -> Pagada (no date) or back. */
export function PaymentStatusRowAction({
  companyId,
  salesDocumentId,
  status,
}: {
  companyId: string;
  salesDocumentId: string;
  status: "pagado" | "impago";
}) {
  const [state, formAction, pending] = useActionState(
    setPaymentStatusAction.bind(null, companyId),
    initialState,
  );
  const next = status === "pagado" ? "impago" : "pagado";

  return (
    <form action={formAction} className="inline">
      <input type="hidden" name="ids" value={salesDocumentId} />
      <button
        type="submit"
        name="status"
        value={next}
        disabled={pending}
        className="text-[11.5px] font-medium text-[var(--color-accent-strong)] disabled:opacity-50"
        title={next === "pagado" ? "Marcar como pagada" : "Marcar como impaga (borra la fecha de pago)"}
      >
        {pending ? "…" : next === "pagado" ? "Marcar pagada" : "Marcar impaga"}
      </button>
      {state.error ? (
        <span role="alert" className="block text-[11px] text-[var(--color-negative-ink)]">
          {state.error}
        </span>
      ) : null}
    </form>
  );
}

/** The detail page's control: status plus an optional payment date. */
export function PaymentStatusForm({
  companyId,
  salesDocumentId,
  status,
  paidAt,
}: {
  companyId: string;
  salesDocumentId: string;
  status: "pagado" | "impago";
  paidAt: string | null;
}) {
  const [state, formAction, pending] = useActionState(
    setPaymentStatusAction.bind(null, companyId),
    initialState,
  );
  const [choice, setChoice] = useState(status);

  return (
    <form action={formAction} className="flex flex-wrap items-end gap-3">
      <input type="hidden" name="ids" value={salesDocumentId} />
      <div className="flex flex-col gap-1">
        <label htmlFor="payment_status" className="field-label">
          Estado de pago
        </label>
        <select
          id="payment_status"
          name="status"
          value={choice}
          onChange={(event) => setChoice(event.target.value as "pagado" | "impago")}
          className="control"
        >
          <option value="impago">Impaga</option>
          <option value="pagado">Pagada</option>
        </select>
      </div>
      {choice === "pagado" ? (
        <div className="flex flex-col gap-1">
          <label htmlFor="paid_at" className="field-label">
            Fecha de pago (opcional)
          </label>
          <input id="paid_at" name="paid_at" type="date" defaultValue={paidAt ?? ""} className="control" />
        </div>
      ) : null}
      <button
        type="submit"
        disabled={pending}
        className="inline-flex min-h-9 items-center rounded-control border border-[var(--color-hairline)] bg-[var(--color-surface)] px-3.5 text-body font-medium text-[var(--color-ink)] hover:border-[var(--color-border-hover)] disabled:opacity-50"
      >
        {pending ? "Guardando…" : "Guardar estado"}
      </button>
      {state.error ? (
        <span role="alert" className="text-[12.5px] text-[var(--color-negative-ink)]">
          {state.error}
        </span>
      ) : state.message ? (
        <span role="status" className="text-[12.5px] text-[var(--color-accent-strong)]">
          Guardado
        </span>
      ) : null}
    </form>
  );
}
