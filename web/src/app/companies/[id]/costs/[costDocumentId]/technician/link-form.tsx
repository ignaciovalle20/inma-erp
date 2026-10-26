"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/Button";
import { formatAmount } from "@/components/Money";
import { fieldInput } from "@/components/FormField";
import { linkAmountCheck } from "@/lib/technicians";
import { assignSupplierToTechnician, linkTechnicianDocument, unlinkTechnicianDocument } from "./actions";

export type LinkableCharge = {
  id: string;
  charge_date: string;
  project_name: string;
  description: string | null;
  /** The cost of the job. */
  cost: number;
  /** What is paid to the technician. */
  payable: number;
  /** "Corregir" (only while it has no payments). */
  editHref: string | null;
};

const money = (value: number) => formatAmount(value, "CLP");

/**
 * Picks the charges a factura or boleta covers: the sum of their costs is
 * checked against the document's net as you tick them, and the link is only
 * offered when it adds up. A document already assigned (to a job, split, to
 * services) asks first: the link replaces that assignment.
 */
export function LinkChargesForm({
  companyId,
  costDocumentId,
  documentNet,
  documentDate,
  documentLabel,
  assignmentLabel,
  servicesHref = null,
  charges,
  preselected,
}: {
  companyId: string;
  costDocumentId: string;
  documentNet: number;
  documentDate: string;
  documentLabel: string;
  /** Where the document is assigned today; null when it is not. */
  assignmentLabel: string | null;
  /**
   * Set when the document is allocated to recurring services: that allocation
   * is removed by hand first (where it is edited), never replaced by the link.
   */
  servicesHref?: string | null;
  charges: LinkableCharge[];
  preselected: string[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(preselected.filter((id) => charges.some((charge) => charge.id === id))),
  );
  const [replace, setReplace] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const picked = charges.filter((charge) => selected.has(charge.id));
  const check = linkAmountCheck(
    picked.map((charge) => charge.cost),
    documentNet,
  );
  const canLink = check.matches && !servicesHref && (assignmentLabel === null || replace);

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function link() {
    setError(null);
    startTransition(async () => {
      const result = await linkTechnicianDocument(companyId, costDocumentId, [...selected], replace);
      if (result.error) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-3">
      {charges.length === 0 ? (
        <p className="text-[13px] text-[var(--color-muted)]">
          Este técnico no tiene cargos pendientes de {documentLabel}. Cargá el cargo en el trabajo (con respaldo{" "}
          {documentLabel}) y volvé a esta pantalla.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-[var(--color-hairline-soft)] rounded-[10px] border border-[var(--color-hairline)]">
          {charges.map((charge) => (
            <li key={charge.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5 text-[12.5px]">
              <input
                id={`charge-${charge.id}`}
                type="checkbox"
                checked={selected.has(charge.id)}
                onChange={() => toggle(charge.id)}
                className="h-4 w-4 rounded border-[var(--color-hairline)]"
              />
              <label htmlFor={`charge-${charge.id}`} className="flex min-w-0 flex-1 flex-col">
                <span className="font-medium text-[var(--color-ink)]">
                  {charge.project_name}
                  {charge.description ? (
                    <span className="font-normal text-[var(--color-muted)]"> · {charge.description}</span>
                  ) : null}
                </span>
                <span className="font-mono text-[11.5px] text-[var(--color-muted)]">
                  {charge.charge_date}
                  {charge.charge_date > documentDate ? " · posterior al documento" : ""}
                </span>
              </label>
              <span className="flex flex-col items-end">
                <span className="font-mono tabular-nums text-[var(--color-ink)]">Costo {money(charge.cost)}</span>
                <span className="font-mono text-[11.5px] tabular-nums text-[var(--color-muted)]">
                  A pagar {money(charge.payable)}
                </span>
              </span>
              {charge.editHref ? (
                <Link href={charge.editHref} className="text-[12px] font-medium text-[var(--color-accent-strong)]">
                  Corregir
                </Link>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <div
        role="status"
        data-testid="link-sum"
        className={`rounded-[8px] px-3 py-2 text-[12.5px] ${
          check.matches
            ? "border border-[var(--color-accent-soft-border)] bg-[var(--color-accent-soft)] text-[var(--color-accent-strong)]"
            : "border border-[var(--color-warning-soft-border)] bg-[var(--color-warning-soft)] text-[var(--color-warning-ink)]"
        }`}
      >
        {picked.length === 0
          ? `Elegí los cargos que cubre esta ${documentLabel}: la suma de sus costos tiene que dar el neto, ${money(documentNet)}.`
          : check.matches
            ? `Cuadra: los costos de ${picked.length} ${picked.length === 1 ? "cargo suman" : "cargos suman"} ${money(check.sum)} y el neto es ${money(documentNet)}.`
            : `No cuadra: los costos suman ${money(check.sum)} y el neto es ${money(documentNet)} (diferencia ${money(check.difference)}). Corregí el cargo o elegí otros.`}
      </div>

      {servicesHref ? (
        <div
          role="alert"
          className="flex flex-col gap-2 rounded-[8px] border border-[var(--color-warning-soft-border)] bg-[var(--color-warning-panel)] px-3 py-2.5 text-[12.5px] text-[var(--color-warning-ink)]"
        >
          <p>
            Este documento está asignado a servicios recurrentes ({assignmentLabel}). Quitá esa asignación antes de
            vincularlo: si no, el servicio volvería a contar su costo estimado además del costo del técnico.
          </p>
          <Link href={servicesHref} className="w-fit font-medium text-[var(--color-warning-ink)] underline">
            Editar la asignación
          </Link>
        </div>
      ) : assignmentLabel ? (
        <div className="flex flex-col gap-2 rounded-[8px] border border-[var(--color-warning-soft-border)] bg-[var(--color-warning-panel)] px-3 py-2.5 text-[12.5px] text-[var(--color-warning-ink)]">
          <p>
            Este documento ya está asignado ({assignmentLabel}). Al vincularlo, esa asignación se reemplaza por la de
            los cargos: cada trabajo queda con el costo de su cargo y el gasto deja de contarse dos veces.
          </p>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={replace}
              onChange={(event) => setReplace(event.target.checked)}
              className="h-4 w-4 rounded border-[var(--color-hairline)]"
            />
            Reemplazar la asignación actual
          </label>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="text-[13px] text-[var(--color-negative-ink)]">
          {error}
        </p>
      ) : null}

      <Button type="button" onClick={link} disabled={!canLink} pending={pending} pendingLabel="Vinculando…">
        Vincular {documentLabel}
      </Button>
    </div>
  );
}

/** Undoes a link: the charges get their own cost back and the document is unassigned again. */
export function UnlinkButton({ companyId, costDocumentId }: { companyId: string; costDocumentId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-2">
      <Button
        type="button"
        variant="secondary"
        pending={pending}
        pendingLabel="Desvinculando…"
        onClick={() => {
          if (
            !window.confirm(
              "¿Desvincular? Cada cargo vuelve a tener su propio costo en su trabajo y el documento queda como gasto general sin asignar.",
            )
          ) {
            return;
          }
          setError(null);
          startTransition(async () => {
            const result = await unlinkTechnicianDocument(companyId, costDocumentId);
            if (result.error) setError(result.error);
            router.refresh();
          });
        }}
      >
        Desvincular
      </Button>
      {error ? (
        <p role="alert" className="text-[13px] text-[var(--color-negative-ink)]">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** "¿De qué técnico es?": adds the document's supplier (its RUT) to a technician's ficha. */
export function AssignSupplierForm({
  companyId,
  costDocumentId,
  supplierId,
  technicians,
}: {
  companyId: string;
  costDocumentId: string;
  supplierId: string;
  technicians: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [personnelId, setPersonnelId] = useState("");
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Técnico"
          value={personnelId}
          onChange={(event) => setPersonnelId(event.target.value)}
          className={`${fieldInput} max-w-[280px]`}
        >
          <option value="">Elegí el técnico</option>
          {technicians.map((technician) => (
            <option key={technician.id} value={technician.id}>
              {technician.name}
            </option>
          ))}
        </select>
        <Button
          type="button"
          variant="secondary"
          disabled={!personnelId}
          pending={pending}
          pendingLabel="Guardando…"
          onClick={() => {
            setError(null);
            startTransition(async () => {
              const result = await assignSupplierToTechnician(companyId, costDocumentId, supplierId, personnelId);
              if (result.error) setError(result.error);
              router.refresh();
            });
          }}
        >
          Es de este técnico
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-[13px] text-[var(--color-negative-ink)]">
          {error}
        </p>
      ) : null}
    </div>
  );
}
