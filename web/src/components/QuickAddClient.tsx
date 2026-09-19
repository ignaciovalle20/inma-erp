"use client";

import { useState, useTransition } from "react";
import { fieldInput, fieldLabel } from "@/components/FormField";

export type QuickAddClientResult =
  | { status: "created"; client: { id: string; name: string; invoiceable: boolean; monthly: boolean } }
  | { status: "warning"; matches: string[] }
  | { status: "error"; error: string };

/**
 * Inline "¿no está en la lista? crear cliente nuevo" affordance for a
 * job-creation form -- avoids sending the user away to /clients/new and
 * back just to register a client mid-flow (docs/cambios-flujo-v2.md
 * 4.1: "alta rápida con nombre y RUT"). Calls the Server Action
 * directly from an event handler wrapped in useTransition (Next.js
 * Server Actions support this outside of a <form>, see
 * node_modules/next/dist/docs/01-app/02-guides/server-actions.md)
 * rather than posting a nested <form>, since a <form> inside the outer
 * project form would be invalid HTML and would submit the wrong thing.
 */
export function QuickAddClient({
  onCreated,
  createClientQuick,
}: {
  onCreated: (client: { id: string; name: string; invoiceable: boolean; monthly: boolean }) => void;
  createClientQuick: (name: string, taxId: string, confirmed: boolean) => Promise<QuickAddClientResult>;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [taxId, setTaxId] = useState("");
  const [warning, setWarning] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(confirmed: boolean) {
    setError(null);
    startTransition(async () => {
      const result = await createClientQuick(name, taxId, confirmed);

      if (result.status === "created") {
        onCreated(result.client);
        setOpen(false);
        setName("");
        setTaxId("");
        setWarning(null);
        return;
      }

      if (result.status === "warning") {
        setWarning(result.matches);
        return;
      }

      setError(result.error);
    });
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="self-start text-[12.5px] font-medium text-[var(--color-accent-strong)]"
      >
        ¿No está en la lista? Crear cliente nuevo
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-[var(--color-hairline)] bg-[var(--color-canvas)] p-3">
      <div className="grid grid-cols-2 gap-2">
        <div className="flex flex-col gap-1">
          <label htmlFor="quick_client_name" className={fieldLabel}>
            Nombre
          </label>
          <input
            id="quick_client_name"
            type="text"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setWarning(null);
            }}
            className={fieldInput}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="quick_client_tax_id" className={fieldLabel}>
            RUT/RUC
          </label>
          <input
            id="quick_client_tax_id"
            type="text"
            value={taxId}
            onChange={(event) => setTaxId(event.target.value)}
            className={`${fieldInput} font-mono`}
          />
        </div>
      </div>

      {warning ? (
        <p role="alert" className="text-[12.5px] text-[var(--color-warning-ink)]">
          Ya existe un cliente parecido: {warning.join(", ")}. Tocá &quot;Crear igual&quot; si es
          distinto.
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="text-[12.5px] text-[var(--color-negative-ink)]">
          {error}
        </p>
      ) : null}

      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={pending || !name.trim()}
          onClick={() => submit(warning !== null)}
          className="rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-[12.5px] font-medium text-[var(--color-on-accent)] disabled:opacity-60"
        >
          {pending ? "Creando…" : warning ? "Crear igual" : "Crear cliente"}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setWarning(null);
            setError(null);
          }}
          className="text-[12.5px] text-[var(--color-muted)]"
        >
          Cancelar
        </button>
      </div>
    </div>
  );
}
