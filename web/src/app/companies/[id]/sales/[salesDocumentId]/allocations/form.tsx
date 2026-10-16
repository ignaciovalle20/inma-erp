"use client";

import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AmountInput } from "@/components/AmountInput";
import { Badge } from "@/components/Badge";
import { Button } from "@/components/Button";
import { Money } from "@/components/Money";
import { fieldInput } from "@/components/FormField";
import { currencyDecimals } from "@/lib/currencies";
import {
  amountTolerance,
  type AllocationTarget,
  type SalesAllocation,
} from "@/lib/salesAllocationsShared";
import { SUGGESTION_REASON_LABELS } from "@/lib/allocationSuggestions";
import { saveSalesAllocations, suggestForDocument, type AllocationRowInput } from "./actions";

type Row = AllocationRowInput & { key: string };

/**
 * Why the row was suggested and, for a period, how far the amount is from
 * what the period still expected (what was not billed yet).
 */
function SuggestionReasonLine({
  reason,
  amount,
  target,
  currency,
}: {
  reason: NonNullable<AllocationRowInput["suggestion_reason"]>;
  amount: number;
  target: AllocationTarget | undefined;
  currency: string;
}) {
  const open =
    target && target.type === "period" && target.expected !== null ? target.expected - target.billed : null;
  const difference = open === null ? null : round(amount - open, currency);
  const differs = difference !== null && Math.abs(difference) > amountTolerance(currency);
  return (
    <p className="text-[11.5px] text-[var(--color-warning-ink)]">
      Sugerida: {SUGGESTION_REASON_LABELS[reason].toLowerCase()}
      {differs ? (
        <>
          {" · difiere del esperado en "}
          {difference! > 0 ? "+" : ""}
          <Money value={difference!} currency={currency} showCurrency={false} negativeClassName="" />
        </>
      ) : null}
    </p>
  );
}

function keyOf(type: string, id: string): string {
  return `${type}:${id}`;
}

function round(value: number, currency: string): number {
  const factor = 10 ** currencyDecimals(currency);
  return Math.round(value * factor) / factor;
}

/**
 * The invoice's allocations: add or remove destinations (recurring service
 * periods and job quotes), split the amounts by hand, confirm suggestions.
 * The exports carry no lines, so the whole document is split with manual
 * amounts; what is not allocated stays as "sin asignar".
 */
export function SalesAllocationForm({
  companyId,
  document,
  allocations,
  targets,
  knownTargets,
}: {
  companyId: string;
  document: { id: string; net_amount: number; currency: string; client_id: string | null };
  allocations: SalesAllocation[];
  /** Destinations offered in the picker. */
  targets: AllocationTarget[];
  /** Labels of the destinations the document already has (may be outside `targets`). */
  knownTargets: Record<string, AllocationTarget>;
}) {
  const router = useRouter();
  const currency = document.currency;
  const [rows, setRows] = useState<Row[]>(() =>
    allocations.map((allocation) => {
      const type = allocation.recurring_service_period_id ? "period" : "quote";
      const id = (allocation.recurring_service_period_id ?? allocation.project_quote_id) as string;
      return {
        key: keyOf(type, id),
        target_type: type,
        target_id: id,
        amount: String(allocation.amount),
        status: allocation.status,
        notes: allocation.notes ?? "",
        suggestion_reason: allocation.suggestion_reason,
      };
    }),
  );
  const [picked, setPicked] = useState("");
  const [message, setMessage] = useState<{ kind: "error" | "ok"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const targetByKey = useMemo(() => {
    const map = new Map<string, AllocationTarget>();
    for (const target of [...targets, ...Object.values(knownTargets)]) {
      map.set(keyOf(target.type, target.id), target);
    }
    return map;
  }, [targets, knownTargets]);

  const allocated = rows.reduce((sum, row) => sum + (Number(row.amount) || 0), 0);
  const remaining = round(document.net_amount - allocated, currency);
  const tolerance = amountTolerance(currency);
  const chosen = new Set(rows.map((row) => row.key));
  const available = targets.filter((target) => !chosen.has(keyOf(target.type, target.id)));
  const periods = available.filter((target) => target.type === "period");
  const quotes = available.filter((target) => target.type !== "period");

  // A hosting invoice usually carries the client's domain too.
  const hostingClients = new Set(
    rows.flatMap((row) => {
      const target = targetByKey.get(row.key);
      return target?.serviceType === "hosting" && target.clientId ? [target.clientId] : [];
    }),
  );
  const domainHints = periods.filter(
    (target) => target.serviceType === "domain" && target.clientId && hostingClients.has(target.clientId),
  );

  function openAmountOf(target: AllocationTarget): number | null {
    if (target.expected === null) return null;
    const open = target.expected - target.billed;
    return open > tolerance ? round(open, currency) : null;
  }

  function addTarget(key: string) {
    const target = targetByKey.get(key);
    if (!target || chosen.has(key)) return;
    const open = openAmountOf(target);
    const left = Math.max(remaining, 0);
    const amount = open !== null && left > 0 ? Math.min(open, left) : left;
    setRows((prev) => [
      ...prev,
      {
        key,
        target_type: target.type,
        target_id: target.id,
        amount: amount > 0 ? String(amount) : "",
        status: "confirmed",
        notes: "",
        suggestion_reason: null,
      },
    ]);
    setPicked("");
    setMessage(null);
  }

  function update(key: string, patch: Partial<Row>) {
    setRows((prev) => prev.map((row) => (row.key === key ? { ...row, ...patch } : row)));
    setMessage(null);
  }

  function remove(key: string) {
    setRows((prev) => prev.filter((row) => row.key !== key));
    setMessage(null);
  }

  function fillRemainder(key: string) {
    const row = rows.find((r) => r.key === key);
    if (!row) return;
    update(key, { amount: String(round((Number(row.amount) || 0) + remaining, currency)) });
  }

  function save(nextRows: Row[]) {
    startTransition(async () => {
      const result = await saveSalesAllocations(
        companyId,
        document.id,
        nextRows.map(({ key, ...row }) => {
          void key;
          return row;
        }),
      );
      if (result.error) {
        setMessage({ kind: "error", text: result.error });
        return;
      }
      setMessage({ kind: "ok", text: "Asignaciones guardadas." });
      router.refresh();
    });
  }

  function confirmAllAndSave() {
    const next = rows.map((row) => ({ ...row, status: "confirmed" as const }));
    setRows(next);
    save(next);
  }

  function suggest() {
    startTransition(async () => {
      const result = await suggestForDocument(companyId, document.id);
      if (result.error) {
        setMessage({ kind: "error", text: result.error });
        return;
      }
      setMessage(
        result.created > 0
          ? { kind: "ok", text: "Se sugirió un destino. Revisalo y confirmalo." }
          : {
              kind: "error",
              text: "No se encontró un destino probable del cliente ese mes (ni una cotización con saldo). Elegilo abajo.",
            },
      );
      router.refresh();
    });
  }

  const hasSuggested = rows.some((row) => row.status === "suggested");
  const over = remaining < -tolerance;

  return (
    <div className="flex flex-col gap-4">
      <dl className="grid grid-cols-3 gap-2 rounded-[10px] border border-[var(--color-hairline)] bg-[var(--color-surface)] p-3 text-[12.5px]">
        <div>
          <dt className="text-[var(--color-muted)]">Neto</dt>
          <dd className="font-medium">
            <Money value={document.net_amount} currency={currency} />
          </dd>
        </div>
        <div>
          <dt className="text-[var(--color-muted)]">Asignado</dt>
          <dd className="font-medium">
            <Money value={allocated} currency={currency} showCurrency={false} />
          </dd>
        </div>
        <div>
          <dt className="text-[var(--color-muted)]">Sin asignar</dt>
          <dd
            className={`font-medium ${
              over
                ? "text-[var(--color-negative-ink)]"
                : remaining > tolerance
                  ? "text-[var(--color-warning-ink)]"
                  : "text-[var(--color-accent-strong)]"
            }`}
          >
            <Money value={remaining} currency={currency} showCurrency={false} />
          </dd>
        </div>
      </dl>

      {rows.length === 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-[10px] border border-dashed border-[var(--color-hairline)] p-4 text-[13px] text-[var(--color-muted)]">
          <span>Esta factura todavía no está asignada a ningún servicio ni cotización.</span>
          <Button type="button" variant="secondary" onClick={suggest} pending={pending} pendingLabel="Buscando…">
            Sugerir destino
          </Button>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((row) => {
            const target = targetByKey.get(row.key);
            const currencyMismatch = target?.currency && target.currency !== currency;
            return (
              <li
                key={row.key}
                className={`flex flex-col gap-2 rounded-[10px] border p-3 ${
                  row.status === "suggested"
                    ? "border-[var(--color-warning-soft-border)] bg-[var(--color-warning-panel)]"
                    : "border-[var(--color-hairline)] bg-[var(--color-surface)]"
                }`}
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge variant="outline">
                        {row.target_type === "period"
                          ? "Servicio"
                          : target && !target.detail.startsWith("COT")
                            ? "Trabajo"
                            : "Cotización"}
                      </Badge>
                      {row.status === "suggested" ? <Badge variant="warning">Sugerida</Badge> : null}
                      <span className="font-medium text-[var(--color-ink)]">{target?.label ?? "Destino"}</span>
                    </div>
                    {row.suggestion_reason ? (
                      <SuggestionReasonLine
                        reason={row.suggestion_reason}
                        amount={Number(row.amount) || 0}
                        target={target}
                        currency={currency}
                      />
                    ) : null}
                    <p className="text-[12px] text-[var(--color-muted)]">
                      {target?.detail}
                      {target?.clientName ? ` · ${target.clientName}` : ""}
                      {target && target.expected !== null ? (
                        <>
                          {" · "}
                          {target.type === "period" ? "esperado" : "cotizado"}{" "}
                          <Money value={target.expected} currency={target.currency ?? currency} showCurrency={false} />
                          {target.billed > 0 ? (
                            <>
                              {" · ya facturado "}
                              <Money value={target.billed} currency={target.currency ?? currency} showCurrency={false} />
                            </>
                          ) : null}
                        </>
                      ) : null}
                    </p>
                    {currencyMismatch ? (
                      <p className="text-[11.5px] text-[var(--color-warning-ink)]">
                        El período es en {target?.currency} y la factura en {currency}: no suma a lo facturado del período.
                      </p>
                    ) : null}
                    {row.notes ? <p className="text-[11.5px] text-[var(--color-faint)]">{row.notes}</p> : null}
                  </div>
                  <div className="flex items-center gap-2">
                    <AmountInput
                      aria-label="Monto asignado"
                      value={row.amount}
                      onValueChange={(value) => update(row.key, { amount: value })}
                      maxDecimals={currencyDecimals(currency)}
                      className={`${fieldInput} w-36 text-right font-mono`}
                    />
                    <button
                      type="button"
                      onClick={() => remove(row.key)}
                      aria-label="Quitar destino"
                      className="px-1 text-[16px] text-[var(--color-muted)] hover:text-[var(--color-negative-ink)]"
                    >
                      ×
                    </button>
                  </div>
                </div>
                <div className="flex flex-wrap gap-3 text-[12px]">
                  {row.status === "suggested" ? (
                    <button
                      type="button"
                      onClick={() => update(row.key, { status: "confirmed" })}
                      className="font-medium text-[var(--color-accent-strong)]"
                    >
                      Confirmar
                    </button>
                  ) : null}
                  {Math.abs(remaining) > tolerance ? (
                    <button
                      type="button"
                      onClick={() => fillRemainder(row.key)}
                      className="text-[var(--color-accent-strong)]"
                    >
                      {remaining > 0 ? "Sumarle lo sin asignar" : "Descontarle el exceso"}
                    </button>
                  ) : null}
                  {target?.type === "period" ? (
                    <Link
                      href={`/companies/${companyId}/recurring-services/periods/${target.id}`}
                      className="text-[var(--color-muted)]"
                    >
                      Ver período
                    </Link>
                  ) : target?.projectId ? (
                    <Link href={`/companies/${companyId}/projects/${target.projectId}`} className="text-[var(--color-muted)]">
                      Ver trabajo
                    </Link>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {domainHints.length > 0 ? (
        <div className="flex flex-col gap-1.5 rounded-[10px] border border-[var(--color-accent-soft-border)] bg-[var(--color-accent-soft)] p-3 text-[12.5px] text-[var(--color-accent-strong)]">
          <span>Es una factura de hosting: ¿incluye también el dominio del cliente?</span>
          <div className="flex flex-wrap gap-2">
            {domainHints.map((target) => (
              <button
                key={target.id}
                type="button"
                onClick={() => addTarget(keyOf(target.type, target.id))}
                className="rounded-md border border-[var(--color-accent-soft-border)] bg-[var(--color-surface)] px-2 py-1 font-medium"
              >
                + {target.label} · {target.detail}
                {target.expected !== null ? (
                  <>
                    {" "}
                    (<Money value={target.expected} currency={target.currency ?? currency} showCurrency={false} />)
                  </>
                ) : null}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Agregar destino"
          value={picked}
          onChange={(event) => setPicked(event.target.value)}
          className={`${fieldInput} min-w-0 flex-1`}
        >
          <option value="">Agregar destino…</option>
          {periods.length > 0 ? (
            <optgroup label="Servicios recurrentes (períodos)">
              {periods.map((target) => (
                <option key={target.id} value={keyOf(target.type, target.id)}>
                  {target.label} · {target.detail}
                  {target.clientName && target.clientId !== document.client_id ? ` · ${target.clientName}` : ""}
                  {target.expected !== null ? ` · ${target.expected.toLocaleString("de-DE")} ${target.currency ?? ""}` : ""}
                  {target.billed > 0 ? " (ya facturado)" : ""}
                </option>
              ))}
            </optgroup>
          ) : null}
          {quotes.length > 0 ? (
            <optgroup label="Cotizaciones de trabajos">
              {quotes.map((target) => (
                <option key={target.id} value={keyOf(target.type, target.id)}>
                  {target.label} · {target.detail}
                  {target.clientName && target.clientId !== document.client_id ? ` · ${target.clientName}` : ""}
                  {target.expected !== null ? ` · cotizado ${target.expected.toLocaleString("de-DE")}` : ""}
                </option>
              ))}
            </optgroup>
          ) : null}
        </select>
        <Button type="button" variant="secondary" disabled={!picked} onClick={() => addTarget(picked)}>
          Agregar
        </Button>
      </div>

      {message ? (
        <p
          role={message.kind === "error" ? "alert" : "status"}
          className={`text-[12.5px] ${
            message.kind === "error" ? "text-[var(--color-negative-ink)]" : "text-[var(--color-accent-strong)]"
          }`}
        >
          {message.text}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" onClick={() => save(rows)} pending={pending} disabled={over}>
          Guardar asignaciones
        </Button>
        {hasSuggested ? (
          <Button type="button" variant="secondary" onClick={confirmAllAndSave} pending={pending} disabled={over}>
            Confirmar todas y guardar
          </Button>
        ) : null}
        {over ? (
          <span className="text-[12px] text-[var(--color-negative-ink)]">
            Lo asignado supera el neto de la factura.
          </span>
        ) : null}
      </div>
    </div>
  );
}
