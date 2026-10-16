"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/Button";
import { fieldInput } from "@/components/FormField";
import { markOccurrenceCollected, undoOccurrenceCollected } from "../../occurrence-actions";
import { adoptBilledAmountAsReference, updatePeriodQuantity } from "./actions";

function useAction() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ kind: "error" | "ok"; text: string } | null>(null);

  function run(action: () => Promise<{ error: string | null; message?: string }>, okText: string) {
    startTransition(async () => {
      const result = await action();
      setMessage(result.error ? { kind: "error", text: result.error } : { kind: "ok", text: result.message ?? okText });
      router.refresh();
    });
  }

  const feedback = message ? (
    <p
      role={message.kind === "error" ? "alert" : "status"}
      className={`text-[12px] ${
        message.kind === "error" ? "text-[var(--color-negative-ink)]" : "text-[var(--color-accent-strong)]"
      }`}
    >
      {message.text}
    </p>
  ) : null;

  return { pending, run, feedback };
}

/** Units of a per-unit period (MS licenses); the expected amount follows. */
export function QuantityForm({
  companyId,
  periodId,
  quantity,
}: {
  companyId: string;
  periodId: string;
  quantity: number | null;
}) {
  const [value, setValue] = useState(quantity === null ? "" : String(quantity));
  const { pending, run, feedback } = useAction();

  return (
    <form
      className="flex flex-col gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        run(() => updatePeriodQuantity(companyId, periodId, value), "Cantidad guardada.");
      }}
    >
      <label htmlFor="quantity" className="field-label">
        Cantidad de este período
      </label>
      <div className="flex items-center gap-2">
        <input
          id="quantity"
          type="number"
          min={0}
          step="any"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          className={`${fieldInput} w-32 font-mono`}
        />
        <Button type="submit" variant="secondary" pending={pending}>
          Guardar
        </Button>
      </div>
      {feedback}
    </form>
  );
}

/**
 * Manual payment state: for a client without invoice it is the period's
 * own; with invoices allocated it marks those invoices paid / unpaid.
 */
export function PaymentToggle({
  companyId,
  periodId,
  paid,
  viaInvoices,
}: {
  companyId: string;
  periodId: string;
  paid: boolean;
  viaInvoices: boolean;
}) {
  const { pending, run, feedback } = useAction();

  return (
    <div className="flex flex-col gap-1.5">
      <Button
        type="button"
        variant="secondary"
        pending={pending}
        onClick={() =>
          run(
            () => (paid ? undoOccurrenceCollected(companyId, periodId) : markOccurrenceCollected(companyId, periodId)),
            paid ? "Marcado como pendiente de pago." : "Marcado como pagado.",
          )
        }
      >
        {paid
          ? viaInvoices
            ? "Marcar facturas como impagas"
            : "Marcar como no pagado"
          : viaInvoices
            ? "Marcar facturas como pagadas"
            : "Marcar como pagado"}
      </Button>
      {feedback}
    </div>
  );
}

/** "Usar este monto como referencial de aquí en adelante". */
export function AdoptReferenceButton({ companyId, periodId }: { companyId: string; periodId: string }) {
  const { pending, run, feedback } = useAction();

  return (
    <div className="flex flex-col gap-1.5">
      <Button
        type="button"
        variant="secondary"
        pending={pending}
        onClick={() => run(() => adoptBilledAmountAsReference(companyId, periodId), "Listo.")}
      >
        Usar este monto como referencial de aquí en adelante
      </Button>
      {feedback}
    </div>
  );
}
