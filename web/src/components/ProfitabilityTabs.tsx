"use client";

import { useState } from "react";
import Link from "next/link";
import { Money } from "@/components/Money";
import { TableCard, Th, Td, Tr } from "@/components/Table";
import type { ProjectSummary, ProjectSummaryTotals } from "@/lib/projectSummary";

/** A job, in its own currency: the six figures of its page. */
export type ProfitabilityProjectRow = {
  id: string;
  name: string;
  href: string;
  clientName: string | null;
  summary: ProjectSummary;
};

/** Jobs added up (a client, an area, a month), in the company's currency. */
export type ProfitabilityGroupRow = {
  id: string;
  name: string;
  totals: ProjectSummaryTotals;
};

const TABS = ["Trabajos", "Clientes", "Áreas", "Meses"] as const;

const KIND_LABEL = { cotizado: "cotizado", facturado: "facturado", gastos: "gastos", tecnicos: "técnicos" } as const;

/** Green when positive, red when negative (Margen and Margen %), as on the job's page. */
function signTone(value: number): string {
  if (value === 0) return "text-[var(--color-ink)]";
  return value > 0 ? "text-[var(--color-accent-strong)]" : "text-[var(--color-negative-ink)]";
}

function Amount({ value, currency, signed = false }: { value: number | null; currency: string; signed?: boolean }) {
  if (value === null) return <span className="font-mono text-[var(--color-muted)]">—</span>;
  return (
    <Money
      value={value}
      currency={currency}
      showCurrency={false}
      className={signed ? `font-medium ${signTone(value)}` : ""}
      negativeClassName={signed ? "" : undefined}
    />
  );
}

function Percent({ value }: { value: number | null }) {
  if (value === null) return <span className="font-mono text-[var(--color-muted)]">—</span>;
  return (
    <span className={`font-mono tabular-nums ${signTone(value)}`}>
      {value.toLocaleString("es", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%
    </span>
  );
}

function FigureHeaders() {
  return (
    <>
      <Th align="right">Cotizado</Th>
      <Th align="right">Facturado</Th>
      <Th align="right">Gastos</Th>
      <Th align="right">Técnicos</Th>
      <Th align="right">Margen</Th>
      <Th align="right">Margen %</Th>
    </>
  );
}

/** What a total says about itself: converted amounts in it, amounts left out, unreadable jobs. */
export function TotalsNotes({ totals }: { totals: ProjectSummaryTotals }) {
  if (!totals.converted && totals.unconverted.length === 0 && totals.unknownJobs === 0) return null;
  return (
    <span className="mt-0.5 flex flex-col text-[11px] font-normal">
      {totals.converted ? (
        <span className="text-[var(--color-muted)]">Incluye montos convertidos a {totals.currency}.</span>
      ) : null}
      {totals.unconverted.length > 0 ? (
        <span className="text-[var(--color-warning-ink)]">
          Sin tipo de cambio, no suma:{" "}
          {totals.unconverted.map((item, index) => (
            <span key={`${item.kind}-${item.currency}`}>
              {index > 0 ? "; " : ""}
              {KIND_LABEL[item.kind]} <Money value={item.amount} currency={item.currency} />
            </span>
          ))}
          .
        </span>
      ) : null}
      {totals.unknownJobs > 0 ? (
        <span className="text-[var(--color-warning-ink)]">
          {totals.unknownJobs === 1 ? "1 trabajo tiene" : `${totals.unknownJobs} trabajos tienen`} cifras que no se
          pudieron leer: el total está incompleto.
        </span>
      ) : null}
    </span>
  );
}

function ProjectTable({ rows, companyCurrency }: { rows: ProfitabilityProjectRow[]; companyCurrency: string }) {
  if (rows.length === 0) {
    return <p className="text-[13px] text-[var(--color-muted)]">No hay trabajos todavía.</p>;
  }
  const showCurrency = rows.some((row) => row.summary.currency !== companyCurrency);
  return (
    <TableCard>
      <thead>
        <tr>
          <Th>Trabajo</Th>
          <Th>Cliente</Th>
          {showCurrency ? <Th>Moneda</Th> : null}
          <FigureHeaders />
        </tr>
      </thead>
      <tbody>
        {rows.map(({ id, name, href, clientName, summary }) => (
          <Tr key={id}>
            <Td className="font-medium text-[var(--color-ink)]">
              <Link href={href} className="text-[var(--color-ink)] no-underline hover:underline">
                {name}
              </Link>
              {summary.excluded.length > 0 ? (
                <span className="block text-[11px] font-normal text-[var(--color-warning-ink)]">
                  No incluye montos en otra moneda:{" "}
                  {summary.excluded.map((item, index) => (
                    <span key={`${item.kind}-${item.currency}`}>
                      {index > 0 ? "; " : ""}
                      {KIND_LABEL[item.kind]} <Money value={item.amount} currency={item.currency} />
                    </span>
                  ))}
                  .
                </span>
              ) : null}
            </Td>
            <Td className="text-[var(--color-ink-2)]">{clientName ?? "—"}</Td>
            {showCurrency ? <Td className="font-mono text-[12.5px] text-[var(--color-ink-2)]">{summary.currency}</Td> : null}
            <Td align="right"><Amount value={summary.quoted} currency={summary.currency} /></Td>
            <Td align="right"><Amount value={summary.billed} currency={summary.currency} /></Td>
            <Td align="right"><Amount value={summary.expenses} currency={summary.currency} /></Td>
            <Td align="right"><Amount value={summary.technicians} currency={summary.currency} /></Td>
            <Td align="right"><Amount value={summary.margin} currency={summary.currency} signed /></Td>
            <Td align="right"><Percent value={summary.marginPct} /></Td>
          </Tr>
        ))}
      </tbody>
    </TableCard>
  );
}

function GroupTable({
  rows,
  heading,
  emptyMessage,
}: {
  rows: ProfitabilityGroupRow[];
  heading: string;
  emptyMessage: string;
}) {
  if (rows.length === 0) {
    return <p className="text-[13px] text-[var(--color-muted)]">{emptyMessage}</p>;
  }
  return (
    <TableCard>
      <thead>
        <tr>
          <Th>{heading}</Th>
          <Th align="right">Trabajos</Th>
          <FigureHeaders />
        </tr>
      </thead>
      <tbody>
        {rows.map(({ id, name, totals }) => (
          <Tr key={id}>
            <Td className="font-medium text-[var(--color-ink)]">
              {name}
              <TotalsNotes totals={totals} />
            </Td>
            <Td align="right" className="font-mono text-[var(--color-ink-2)]">{totals.jobs}</Td>
            <Td align="right"><Amount value={totals.quoted} currency={totals.currency} /></Td>
            <Td align="right"><Amount value={totals.billed} currency={totals.currency} /></Td>
            <Td align="right"><Amount value={totals.expenses} currency={totals.currency} /></Td>
            <Td align="right"><Amount value={totals.technicians} currency={totals.currency} /></Td>
            <Td align="right"><Amount value={totals.margin} currency={totals.currency} signed /></Td>
            <Td align="right"><Percent value={totals.marginPct} /></Td>
          </Tr>
        ))}
      </tbody>
    </TableCard>
  );
}

export function ProfitabilityTabs({
  currency,
  projects,
  clients,
  areas,
  months,
}: {
  /** The company's currency: the one of the totals by client, area and month. */
  currency: string;
  projects: ProfitabilityProjectRow[];
  clients: ProfitabilityGroupRow[];
  areas: ProfitabilityGroupRow[];
  months: ProfitabilityGroupRow[];
}) {
  const [tab, setTab] = useState<(typeof TABS)[number]>("Trabajos");

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex gap-1.5" role="tablist">
          {TABS.map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={`tab-chip ${tab === t ? "tab-chip-active" : ""}`}
            >
              {t}
            </button>
          ))}
        </div>
        <p className="text-small text-[var(--color-muted)]">
          {tab === "Trabajos"
            ? "Cada trabajo en su moneda, con las mismas cifras que su ficha."
            : tab === "Meses"
              ? `Trabajos según su fecha de inicio (o de alta), sumados en ${currency}.`
              : `Trabajos sumados en ${currency}.`}
        </p>
      </div>

      {tab === "Trabajos" ? (
        <ProjectTable rows={projects} companyCurrency={currency} />
      ) : tab === "Clientes" ? (
        <GroupTable rows={clients} heading="Cliente" emptyMessage="No hay trabajos todavía." />
      ) : tab === "Áreas" ? (
        <GroupTable rows={areas} heading="Área de negocio" emptyMessage="No hay trabajos todavía." />
      ) : (
        <GroupTable rows={months} heading="Mes" emptyMessage="No hay trabajos todavía." />
      )}
    </div>
  );
}
