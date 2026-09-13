"use client";

import { useState } from "react";
import Link from "next/link";
import { Money } from "@/components/Money";
import { Badge } from "@/components/Badge";
import { TableCard, Th, Td, Tr } from "@/components/Table";

type SimpleRow = {
  id: string;
  name: string;
  revenue: number;
  costs: number;
  margin: number;
  revenueHref: string;
  costsHref: string;
};

type ProjectRow = SimpleRow & {
  clientName: string | null;
  accumulatedRevenue: number;
  accumulatedCosts: number;
  accumulatedMargin: number;
  budget: number | null;
  budgetVariance: number | null;
};

const TABS = ["Proyectos", "Clientes", "Áreas"] as const;

function SimpleTable({
  rows,
  currency,
  emptyMessage,
}: {
  rows: SimpleRow[];
  currency: string;
  emptyMessage: string;
}) {
  if (rows.length === 0) {
    return <p className="text-[13px] text-[var(--color-muted)]">{emptyMessage}</p>;
  }
  return (
    <TableCard>
      <thead>
        <tr>
          <Th>Nombre</Th>
          <Th align="right">Ingresos</Th>
          <Th align="right">Costos</Th>
          <Th align="right">Margen</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <Tr key={row.id}>
            <Td className="font-medium text-[var(--color-ink)]">{row.name}</Td>
            <Td align="right">
              <Link
                href={row.revenueHref}
                className="border-b border-[var(--color-accent-soft-border)] text-[var(--color-ink)] no-underline"
              >
                <Money value={row.revenue} currency={currency} showCurrency={false} />
              </Link>
            </Td>
            <Td align="right">
              <Link
                href={row.costsHref}
                className="border-b border-[var(--color-accent-soft-border)] text-[var(--color-ink)] no-underline"
              >
                <Money value={row.costs} currency={currency} showCurrency={false} />
              </Link>
            </Td>
            <Td align="right" className="font-medium">
              <Money value={row.margin} currency={currency} showCurrency={false} />
            </Td>
          </Tr>
        ))}
      </tbody>
    </TableCard>
  );
}

function ProjectTable({
  rows,
  currency,
  emptyMessage,
}: {
  rows: ProjectRow[];
  currency: string;
  emptyMessage: string;
}) {
  if (rows.length === 0) {
    return <p className="text-[13px] text-[var(--color-muted)]">{emptyMessage}</p>;
  }
  return (
    <TableCard>
      <thead>
        <tr>
          <Th>Proyecto</Th>
          <Th>Cliente</Th>
          <Th align="right">Ingresos</Th>
          <Th align="right">Costos</Th>
          <Th align="right">Margen</Th>
          <Th align="right">Acumulado</Th>
          <Th align="right">Presupuesto</Th>
          <Th align="right">Desvío</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <Tr key={row.id}>
            <Td className="font-medium text-[var(--color-ink)]">{row.name}</Td>
            <Td className="text-[var(--color-ink-2)]">{row.clientName ?? "—"}</Td>
            <Td align="right">
              <Link
                href={row.revenueHref}
                className="border-b border-[var(--color-accent-soft-border)] text-[var(--color-ink)] no-underline"
              >
                <Money value={row.revenue} currency={currency} showCurrency={false} />
              </Link>
            </Td>
            <Td align="right">
              <Link
                href={row.costsHref}
                className="border-b border-[var(--color-accent-soft-border)] text-[var(--color-ink)] no-underline"
              >
                <Money value={row.costs} currency={currency} showCurrency={false} />
              </Link>
            </Td>
            <Td align="right" className="font-medium">
              <Money value={row.margin} currency={currency} showCurrency={false} />
            </Td>
            <Td align="right">
              <div className="flex flex-col items-end">
                <Money value={row.accumulatedMargin} currency={currency} showCurrency={false} className="font-medium" />
                <span className="text-[10.5px] font-normal text-[var(--color-faint)]">
                  ing {row.accumulatedRevenue.toLocaleString()} / cos{" "}
                  {row.accumulatedCosts.toLocaleString()}
                </span>
              </div>
            </Td>
            <Td align="right">
              {row.budget === null ? "—" : (
                <Money value={row.budget} currency={currency} showCurrency={false} />
              )}
            </Td>
            <Td align="right">
              {row.budget === null || row.budgetVariance === null ? (
                <Badge variant="neutral">Sin presupuesto</Badge>
              ) : row.budgetVariance > 0 ? (
                <Badge variant="negative">
                  +<Money value={row.budgetVariance} currency={currency} showCurrency={false} />
                </Badge>
              ) : (
                <Badge variant="positive">
                  <Money value={row.budgetVariance} currency={currency} showCurrency={false} />
                </Badge>
              )}
            </Td>
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
}: {
  currency: string;
  projects: ProjectRow[];
  clients: SimpleRow[];
  areas: SimpleRow[];
}) {
  const [tab, setTab] = useState<(typeof TABS)[number]>("Proyectos");

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div className="flex gap-1.5">
          {TABS.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`rounded-lg px-3.5 py-[7px] text-[13px] font-medium ${
                tab === t
                  ? "bg-[var(--color-ink)] text-[#f2f2ef]"
                  : "border border-[var(--color-hairline)] bg-white text-[var(--color-ink-2)]"
              }`}
            >
              {t}
            </button>
          ))}
        </div>
        <p className="text-[12.5px] text-[var(--color-muted)]">
          Los importes enlazan al detalle de ventas y costos del mismo período.
        </p>
      </div>

      {tab === "Proyectos" ? (
        <ProjectTable rows={projects} currency={currency} emptyMessage="No hay proyectos todavía." />
      ) : tab === "Clientes" ? (
        <SimpleTable rows={clients} currency={currency} emptyMessage="No hay clientes todavía." />
      ) : (
        <SimpleTable rows={areas} currency={currency} emptyMessage="No hay áreas de negocio todavía." />
      )}
    </div>
  );
}
