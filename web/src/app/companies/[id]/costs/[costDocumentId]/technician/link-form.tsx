"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AmountInput } from "@/components/AmountInput";
import { Badge } from "@/components/Badge";
import { Button } from "@/components/Button";
import { formatAmount } from "@/components/Money";
import { fieldInput } from "@/components/FormField";
import {
  applicationCheck,
  backedChargeAmounts,
  boletaLinkCheck,
  chargeAmountLines,
  conversionEntryMode,
  ENTRY_MODES,
  parseApplied,
  payableOfApplied,
  withholdingRateFor,
  type Backing,
  type EnteredAs,
  type WithholdingRate,
} from "@/lib/technicians";
import {
  applyTechnicianDocument,
  assignSupplierToTechnician,
  createChargeFromDocument,
  unlinkTechnicianDocument,
} from "./actions";

export type LinkableCharge = {
  id: string;
  charge_date: string;
  project_name: string;
  description: string | null;
  backing: Backing | null;
  /** The cost of the job: net of a factura, bruto of a boleta. */
  cost: number;
  /** What is paid to the technician. */
  payable: number;
  /** Paid so far on the charge. */
  paid: number;
  /** Of its cost, what other documents already cover. */
  applied: number;
  /** "Corregir" (only while it has no payments). */
  editHref: string | null;
};

const money = (value: number) => formatAmount(value, "CLP");

function BreakdownLine({ backing, cost, payable }: { backing: Backing | null; cost: number; payable: number }) {
  return (
    <span className="font-mono text-[11.5px] tabular-nums text-[var(--color-ink-2)]">
      {chargeAmountLines({ backing, amount: payable, net_amount: cost })
        .map((line) => `${line.label} ${money(line.value)}`)
        .join(" · ")}
    </span>
  );
}

/**
 * Picks the charges a factura or boleta covers, from any job of the technician,
 * and how much of each: the sum of what is applied is checked against the
 * document's net as you go, always net with net (bruto with bruto for a boleta,
 * líquido with líquido apart). A difference does not block: it asks to be
 * confirmed. A charge without backing takes the document's: its amount is read
 * as the total (or líquido) unless told otherwise. A document already assigned
 * (to a job, split, to services) asks first: the link replaces that assignment.
 */
export function LinkChargesForm({
  companyId,
  costDocumentId,
  documentBacking,
  documentNet,
  documentLiquid = null,
  documentDate,
  documentLabel,
  assignmentLabel,
  servicesHref = null,
  charges,
  otherBackingCharges,
  preselected,
  withholdingRates,
  technicianId,
  projects,
}: {
  companyId: string;
  costDocumentId: string;
  documentBacking: "factura" | "boleta";
  documentNet: number;
  /** Boletas: what the technician is paid; documentNet is then the bruto. */
  documentLiquid?: number | null;
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
  otherBackingCharges: LinkableCharge[];
  preselected: string[];
  withholdingRates: WithholdingRate[];
  technicianId: string;
  projects: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(preselected.filter((id) => charges.some((charge) => charge.id === id))),
  );
  /** What was typed per charge; a charge not here applies all it has pending. */
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [entryModes, setEntryModes] = useState<Record<string, EnteredAs>>({});
  const [replace, setReplace] = useState(false);
  const [acceptDifference, setAcceptDifference] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const netWord = documentBacking === "boleta" ? "bruto" : "neto";
  const needsBacking = (charge: LinkableCharge) => charge.backing === null || charge.backing === "none";

  /** The charge's amounts as they will be: a charge without backing, read as the document's. */
  function amountsOf(charge: LinkableCharge): { cost: number; payable: number } | null {
    if (!needsBacking(charge)) return { cost: charge.cost, payable: charge.payable };
    const amounts = backedChargeAmounts({
      backing: documentBacking,
      enteredAs: entryModes[charge.id] ?? conversionEntryMode(documentBacking),
      value: charge.payable,
      withholdingRate: withholdingRateFor(withholdingRates, charge.charge_date),
    });
    return amounts ? { cost: amounts.cost, payable: amounts.payable } : null;
  }

  const picked = charges.filter((charge) => selected.has(charge.id));
  const rows = picked.map((charge) => {
    const amounts = amountsOf(charge);
    const pendingCost = amounts ? amounts.cost - charge.applied : 0;
    const parsed = parseApplied(typed[charge.id] ?? String(pendingCost), pendingCost);
    return { charge, amounts, pendingCost, parsed };
  });
  const applied = rows.map((row) => row.parsed.value ?? 0);
  const check = applicationCheck(applied, documentNet);
  const rowsValid = rows.every((row) => row.parsed.error === null && row.amounts !== null);
  const canLink =
    picked.length > 0 &&
    rowsValid &&
    (check.matches || acceptDifference) &&
    !servicesHref &&
    (assignmentLabel === null || replace);
  const liquidCheck =
    documentLiquid === null
      ? null
      : applicationCheck(
          rows.map((row, index) => (row.amounts ? payableOfApplied(row.amounts, applied[index]) : 0)),
          documentLiquid,
        );
  const looksCrossed =
    documentLiquid !== null &&
    boletaLinkCheck(
      rows.flatMap((row) => (row.amounts ? [row.amounts] : [])),
      { gross: documentNet, liquid: documentLiquid },
    ).looksCrossed;

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
      const result = await applyTechnicianDocument(
        companyId,
        costDocumentId,
        rows.map((row, index) => ({
          charge_id: row.charge.id,
          amount: applied[index],
          entered_as: needsBacking(row.charge)
            ? (entryModes[row.charge.id] ?? conversionEntryMode(documentBacking))
            : null,
        })),
        replace,
        !check.matches && acceptDifference,
      );
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
          Este técnico no tiene cargos pendientes de {documentLabel}. Si el cargo no existe, crealo acá abajo.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-[var(--color-hairline-soft)] rounded-[10px] border border-[var(--color-hairline)]">
          {charges.map((charge) => {
            const isSelected = selected.has(charge.id);
            const row = rows.find((candidate) => candidate.charge.id === charge.id);
            const shown = amountsOf(charge) ?? { cost: charge.cost, payable: charge.payable };
            return (
              <li key={charge.id} data-testid="link-charge" className="flex flex-col gap-2 px-3 py-2.5 text-[12.5px]">
                <div className="flex flex-wrap items-center gap-3">
                  <input
                    id={`charge-${charge.id}`}
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggle(charge.id)}
                    className="h-4 w-4 rounded border-[var(--color-hairline)]"
                  />
                  <label htmlFor={`charge-${charge.id}`} className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="font-medium text-[var(--color-ink)]">
                      {charge.project_name}
                      {charge.description ? (
                        <span className="font-normal text-[var(--color-muted)]"> · {charge.description}</span>
                      ) : null}
                    </span>
                    <span className="font-mono text-[11.5px] text-[var(--color-muted)]">
                      {charge.charge_date}
                      {charge.charge_date > documentDate ? " · posterior al documento" : ""}
                      {charge.paid > 0 ? ` · pagado ${money(charge.paid)}` : ""}
                      {charge.applied > 0 ? ` · ya cubierto ${money(charge.applied)}` : ""}
                    </span>
                    <BreakdownLine
                      backing={needsBacking(charge) ? documentBacking : charge.backing}
                      cost={shown.cost}
                      payable={shown.payable}
                    />
                  </label>
                  {needsBacking(charge) ? <Badge variant="neutral">Sin respaldo</Badge> : null}
                  {charge.editHref ? (
                    <Link href={charge.editHref} className="text-[12px] font-medium text-[var(--color-accent-strong)]">
                      Corregir
                    </Link>
                  ) : null}
                </div>

                {isSelected ? (
                  <div className="flex flex-wrap items-center gap-3 pl-7">
                    {needsBacking(charge) ? (
                      <label className="flex items-center gap-1.5 text-[12px] text-[var(--color-ink-2)]">
                        Su monto de {money(charge.payable)} es
                        <select
                          aria-label={`Cómo se lee el monto de ${charge.project_name}`}
                          value={entryModes[charge.id] ?? conversionEntryMode(documentBacking)}
                          onChange={(event) => {
                            const mode = event.target.value as EnteredAs;
                            setEntryModes((current) => ({ ...current, [charge.id]: mode }));
                            setTyped((current) => {
                              const next = { ...current };
                              delete next[charge.id];
                              return next;
                            });
                          }}
                          className={`${fieldInput} w-auto py-1 text-[12px]`}
                        >
                          {ENTRY_MODES[documentBacking].map((mode) => (
                            <option key={mode.value} value={mode.value}>
                              {mode.label}
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : null}
                    <label className="flex items-center gap-1.5 text-[12px] text-[var(--color-ink-2)]">
                      Aplicar ({netWord})
                      <AmountInput
                        aria-label={`Aplicar a ${charge.project_name}`}
                        maxDecimals={0}
                        value={typed[charge.id] ?? String(row?.pendingCost ?? 0)}
                        onValueChange={(value) => setTyped((current) => ({ ...current, [charge.id]: value }))}
                        className="w-[112px] rounded-lg border border-[var(--color-hairline)] bg-[var(--color-surface)] px-2 py-1 text-right font-mono text-[12.5px] text-[var(--color-ink)] outline-none focus:border-[var(--color-ink)]"
                      />
                    </label>
                    {row && row.parsed.value !== null && row.parsed.value < row.pendingCost ? (
                      <span className="text-[11.5px] text-[var(--color-warning-ink)]">
                        Parcial: quedan {money(row.pendingCost - row.parsed.value)} pendientes de documento.
                      </span>
                    ) : null}
                    {row?.parsed.error ? (
                      <span role="alert" className="text-[11.5px] text-[var(--color-negative-ink)]">
                        {row.parsed.error}
                      </span>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {otherBackingCharges.length > 0 ? (
        <div className="flex flex-col gap-1 text-[12px] text-[var(--color-muted)]">
          <span>
            Con otro respaldo (no se pueden elegir para esta {documentLabel}; corregí el cargo si el respaldo está mal):
          </span>
          <ul className="flex flex-col gap-0.5">
            {otherBackingCharges.map((charge) => (
              <li key={charge.id} className="flex flex-wrap gap-2">
                <span>
                  {charge.charge_date} · {charge.project_name} · {charge.backing === "boleta" ? "boleta" : "factura"}
                </span>
                {charge.editHref ? (
                  <Link href={charge.editHref} className="font-medium text-[var(--color-accent-strong)]">
                    Corregir
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <NewChargeForm
        companyId={companyId}
        costDocumentId={costDocumentId}
        technicianId={technicianId}
        backing={documentBacking}
        documentDate={documentDate}
        projects={projects}
        suggestedNet={Math.max(check.difference, 0)}
        onCreated={(id) => setSelected((current) => new Set(current).add(id))}
      />

      <div
        role="status"
        data-testid="link-sum"
        className={`rounded-[8px] px-3 py-2 text-[12.5px] ${
          picked.length > 0 && check.matches
            ? "border border-[var(--color-accent-soft-border)] bg-[var(--color-accent-soft)] text-[var(--color-accent-strong)]"
            : "border border-[var(--color-warning-soft-border)] bg-[var(--color-warning-soft)] text-[var(--color-warning-ink)]"
        }`}
      >
        {picked.length === 0 ? (
          `Elegí los cargos que cubre esta ${documentLabel}: lo aplicado tiene que dar el ${netWord}, ${money(documentNet)}.`
        ) : (
          <>
            <span className="block font-medium">{check.matches ? "Cuadra" : "No cuadra"}</span>
            <span className="block font-mono tabular-nums">
              {netWord === "neto" ? "Netos" : "Brutos"} seleccionados {money(check.sum)} ({picked.length}{" "}
              {picked.length === 1 ? "cargo" : "cargos"}) · {netWord === "neto" ? "Neto" : "Bruto"} del documento{" "}
              {money(documentNet)} · Diferencia {money(check.difference)}
            </span>
          </>
        )}
        {liquidCheck && documentLiquid !== null && picked.length > 0 ? (
          <span className="block">
            Líquido: los cargos pagan {money(liquidCheck.sum)} y la boleta da {money(documentLiquid)}
            {liquidCheck.matches ? "." : ` (diferencia ${money(liquidCheck.difference)}).`}
          </span>
        ) : null}
        {looksCrossed ? (
          <span className="block font-medium">
            El bruto de esta boleta es igual a lo que pagan los cargos (su líquido): probablemente no es la boleta de
            estos cargos. Revisá las otras boletas del técnico.
          </span>
        ) : null}
      </div>

      {picked.length > 0 && !check.matches ? (
        <label className="flex items-start gap-2 rounded-[8px] border border-[var(--color-warning-soft-border)] bg-[var(--color-warning-panel)] px-3 py-2.5 text-[12.5px] text-[var(--color-warning-ink)]">
          <input
            type="checkbox"
            checked={acceptDifference}
            onChange={(event) => setAcceptDifference(event.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-[var(--color-hairline)]"
          />
          <span>
            Vincular igual con una diferencia de {money(check.difference)}.{" "}
            {check.difference > 0
              ? "Esa parte del documento queda como costo general."
              : "Los cargos cuestan más que el documento: esa parte baja el costo general."}
          </span>
        </label>
      ) : null}

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
            los cargos: cada trabajo queda con el costo de su cargo, en el mes del cargo, y el gasto deja de
            contarse dos veces.
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

/**
 * "Crear un cargo": a charge that does not exist yet, without leaving the
 * document. Starts on what the document still has to cover, in net.
 */
function NewChargeForm({
  companyId,
  costDocumentId,
  technicianId,
  backing,
  documentDate,
  projects,
  suggestedNet,
  onCreated,
}: {
  companyId: string;
  costDocumentId: string;
  technicianId: string;
  backing: "factura" | "boleta";
  documentDate: string;
  projects: { id: string; name: string }[];
  /** What the document still has to cover. */
  suggestedNet: number;
  onCreated: (chargeId: string) => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [projectId, setProjectId] = useState("");
  const [chargeDate, setChargeDate] = useState(documentDate);
  const [description, setDescription] = useState("");
  const netMode: EnteredAs = backing === "factura" ? "net" : "gross";
  const [enteredAs, setEnteredAs] = useState<EnteredAs>(netMode);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => {
          setValue(suggestedNet > 0 ? String(suggestedNet) : "");
          setEnteredAs(netMode);
          setOpen(true);
        }}
        className="w-fit text-[13px] font-medium text-[var(--color-accent-strong)]"
      >
        + Crear un cargo que falta
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-[10px] border border-[var(--color-hairline)] p-3 text-[12.5px]">
      <span className="caps-label text-[var(--color-muted)]">Cargo nuevo</span>
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Proyecto del cargo nuevo"
          value={projectId}
          onChange={(event) => setProjectId(event.target.value)}
          className={`${fieldInput} max-w-[280px]`}
        >
          <option value="">Elegí el proyecto</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
        <input
          type="date"
          aria-label="Fecha del cargo nuevo"
          value={chargeDate}
          onChange={(event) => setChargeDate(event.target.value)}
          className={`${fieldInput} w-auto`}
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <AmountInput
          aria-label="Monto del cargo nuevo"
          maxDecimals={0}
          value={value}
          onValueChange={setValue}
          className="w-[128px] rounded-lg border border-[var(--color-hairline)] bg-[var(--color-surface)] px-2 py-[7px] text-right font-mono text-[12.5px] text-[var(--color-ink)] outline-none focus:border-[var(--color-ink)]"
        />
        <select
          aria-label="Cómo se ingresa el monto del cargo nuevo"
          value={enteredAs}
          onChange={(event) => setEnteredAs(event.target.value as EnteredAs)}
          className={`${fieldInput} w-auto`}
        >
          {ENTRY_MODES[backing].map((mode) => (
            <option key={mode.value} value={mode.value}>
              {mode.label}
            </option>
          ))}
        </select>
        <input
          aria-label="Descripción del cargo nuevo"
          placeholder="Descripción (opcional)"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          className={`${fieldInput} min-w-[160px] flex-1`}
        />
      </div>
      {error ? (
        <p role="alert" className="text-[13px] text-[var(--color-negative-ink)]">
          {error}
        </p>
      ) : null}
      <div className="flex items-center gap-3">
        <Button
          type="button"
          variant="secondary"
          disabled={!projectId || value.trim() === ""}
          pending={pending}
          pendingLabel="Creando…"
          onClick={() => {
            setError(null);
            startTransition(async () => {
              const result = await createChargeFromDocument(companyId, costDocumentId, {
                personnelId: technicianId,
                projectId,
                chargeDate,
                description,
                backing,
                enteredAs,
                value,
              });
              if (result.error || !result.chargeId) {
                setError(result.error ?? "No se pudo crear el cargo.");
                return;
              }
              onCreated(result.chargeId);
              setOpen(false);
              setProjectId("");
              setDescription("");
              router.refresh();
            });
          }}
        >
          Crear cargo
        </Button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-[13px] text-[var(--color-muted)] hover:text-[var(--color-ink)]"
        >
          Cancelar
        </button>
      </div>
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
