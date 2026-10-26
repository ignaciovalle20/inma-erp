"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/Button";
import { fieldInput, fieldLabel } from "@/components/FormField";
import { addTechnicianTaxId, linkTechnicianSupplier, unlinkTechnicianSupplier } from "./supplier-actions";

type LinkedSupplier = { id: string; supplier_name: string; tax_id: string | null };

/**
 * "RUTs / proveedores vinculados" of a Chilean technician: their personal RUT
 * for boletas, their company's for facturas... Each one makes that
 * supplier's imported documents recognizable as this technician's.
 */
export function TechnicianSuppliers({
  companyId,
  personnelId,
  linked,
  available,
}: {
  companyId: string;
  personnelId: string;
  linked: LinkedSupplier[];
  /** Suppliers of the company not linked to any technician. */
  available: { id: string; name: string; tax_id: string | null }[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [taxId, setTaxId] = useState("");
  const [name, setName] = useState("");
  const [supplierId, setSupplierId] = useState("");
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  function run(action: () => Promise<{ error: string | null; suggestions?: number }>, done: () => void) {
    setMessage(null);
    startTransition(async () => {
      const result = await action();
      if (result.error) {
        setMessage({ text: result.error, error: true });
        return;
      }
      done();
      if (result.suggestions) {
        setMessage({
          text: `${result.suggestions} ${result.suggestions === 1 ? "documento sugerido" : "documentos sugeridos"} para vincular: revisalos en Conciliar.`,
          error: false,
        });
      }
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <span className={fieldLabel}>RUT / proveedores vinculados</span>
        {linked.length === 0 ? (
          <p className="text-[12.5px] text-[var(--color-muted)]">
            Ninguno todavía. Con su RUT vinculado, sus facturas y boletas importadas se reconocen como suyas.
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-[var(--color-hairline-soft)] rounded-[10px] border border-[var(--color-hairline)]">
            {linked.map((supplier) => (
              <li key={supplier.id} className="flex items-center justify-between gap-3 px-3 py-2 text-[12.5px]">
                <span>
                  <span className="font-mono text-[var(--color-ink)]">{supplier.tax_id ?? "sin RUT"}</span>{" "}
                  <span className="text-[var(--color-muted)]">· {supplier.supplier_name}</span>
                </span>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => run(() => unlinkTechnicianSupplier(companyId, personnelId, supplier.id), () => {})}
                  className="text-[12px] font-medium text-[var(--color-muted)] hover:text-[var(--color-negative-ink)] disabled:opacity-60"
                >
                  Quitar
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <span className={fieldLabel}>Agregar un RUT</span>
        <div className="flex flex-wrap gap-2">
          <input
            aria-label="RUT"
            placeholder="12.345.678-9"
            value={taxId}
            onChange={(event) => setTaxId(event.target.value)}
            className={`${fieldInput} max-w-[160px] font-mono`}
          />
          <input
            aria-label="Nombre del proveedor (si no existe)"
            placeholder="Nombre (si hay que crearlo)"
            value={name}
            onChange={(event) => setName(event.target.value)}
            className={`${fieldInput} min-w-[180px] flex-1`}
          />
          <Button
            type="button"
            variant="secondary"
            disabled={!taxId.trim()}
            pending={pending}
            onClick={() =>
              run(
                () => addTechnicianTaxId(companyId, personnelId, taxId, name),
                () => {
                  setTaxId("");
                  setName("");
                },
              )
            }
          >
            Agregar RUT
          </Button>
        </div>
        <p className="text-[11.5px] text-[var(--color-muted)]">
          Busca el proveedor por RUT (sin importar puntos ni guion); si no existe, lo crea.
        </p>
      </div>

      {available.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <span className={fieldLabel}>O elegir un proveedor existente</span>
          <div className="flex flex-wrap gap-2">
            <select
              aria-label="Proveedor existente"
              value={supplierId}
              onChange={(event) => setSupplierId(event.target.value)}
              className={`${fieldInput} min-w-[220px] flex-1`}
            >
              <option value="">Elegí un proveedor</option>
              {available.map((supplier) => (
                <option key={supplier.id} value={supplier.id}>
                  {supplier.name}
                  {supplier.tax_id ? ` · ${supplier.tax_id}` : ""}
                </option>
              ))}
            </select>
            <Button
              type="button"
              variant="secondary"
              disabled={!supplierId}
              pending={pending}
              onClick={() =>
                run(
                  () => linkTechnicianSupplier(companyId, personnelId, supplierId),
                  () => setSupplierId(""),
                )
              }
            >
              Vincular
            </Button>
          </div>
        </div>
      ) : null}

      {message ? (
        <p
          role={message.error ? "alert" : "status"}
          className={`text-[12.5px] ${message.error ? "text-[var(--color-negative-ink)]" : "text-[var(--color-accent-strong)]"}`}
        >
          {message.text}
        </p>
      ) : null}
    </div>
  );
}
