import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession, getCompanyForEdit, getRecurringServiceCostPools, getMsLicensePoolMonths } from "@/lib/dal";
import { monthsToSplit, monthsWithPoolDifference } from "@/lib/msLicensePool";
import { PageHeader } from "@/components/PageHeader";
import { LinkButton } from "@/components/Button";
import { StatusDot } from "@/components/StatusDot";
import { Money } from "@/components/Money";
import { TableCard, Th, Td, Tr } from "@/components/Table";
import { EmptyState } from "@/components/EmptyState";
import { SERVICE_TYPE_LABELS, type ServiceType } from "@/lib/recurringServiceTypes";

function formatPeriod(period: string): string {
  const [year, month] = period.split("-");
  const MONTH_LABELS = [
    "ene", "feb", "mar", "abr", "may", "jun",
    "jul", "ago", "sep", "oct", "nov", "dic",
  ];
  return `${MONTH_LABELS[Number(month) - 1]} ${year}`;
}

export default async function CostPoolsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await getSession();

  if (!user) {
    redirect("/login");
  }

  const membership = await getCompanyForEdit(id);

  if (!membership) {
    redirect("/companies");
  }

  const [pools, supplierMonths] = await Promise.all([getRecurringServiceCostPools(id), getMsLicensePoolMonths(id)]);
  // Months of Intcomex / TGM invoices without a pool (fix-math 2026-11,
  // point 2), and pools that no longer match their month's invoices.
  const pending = monthsToSplit(supplierMonths.months);
  const mismatched = monthsWithPoolDifference(supplierMonths.months);

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <PageHeader
        eyebrow="GESTIÓN / COSTOS / REPARTO LICENCIAS MS"
        title="Reparto licencias MS"
        subtitle={membership.company.name}
        back={{
          href: `/companies/${id}/costs`,
          label: "Costos",
        }}
        actions={
          <LinkButton
            href={`/companies/${id}/costs/ms-licenses/new`}
            variant="primary"
          >
            Nuevo pool
          </LinkButton>
        }
      />

      {supplierMonths.failed ? (
        <p className="text-[12.5px] text-[var(--color-warning-ink)]">
          No se pudieron leer las facturas del proveedor de licencias: no se sabe si hay meses sin repartir.
        </p>
      ) : null}

      {pending.length > 0 ? (
        <div className="flex flex-col gap-2 rounded-[10px] border border-[var(--color-warning-soft-border)] bg-[var(--color-warning-panel)] px-4 py-3">
          <span className="text-[13px] font-semibold text-[var(--color-warning-ink-2)]">
            Facturas de licencias sin repartir
          </span>
          <span className="text-[12.5px] text-[var(--color-warning-ink)]">
            Mientras un mes no se reparte, su factura cuenta como gasto general y los servicios de licencias quedan
            sin costo. Revisá la propuesta de cada mes y confirmala.
          </span>
          <ul className="flex flex-col gap-1 text-[12.5px]">
            {pending.map((month) => (
              <li key={`${month.period}-${month.currency}`} className="flex flex-wrap items-center gap-2">
                <span className="w-16 font-medium text-[var(--color-ink)]">{formatPeriod(month.period)}</span>
                <span className="text-[var(--color-ink-2)]">
                  {month.supplierName} · {month.documentCount} factura{month.documentCount === 1 ? "" : "s"} ·{" "}
                  <Money value={month.netTotal} currency={month.currency} />
                </span>
                <Link
                  href={`/companies/${id}/costs/ms-licenses/propose?period=${month.period.slice(0, 7)}`}
                  className="font-medium text-[var(--color-accent-strong)]"
                >
                  Ver propuesta
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {mismatched.length > 0 ? (
        <p className="text-[12.5px] text-[var(--color-warning-ink)]">
          El monto del reparto no coincide con las facturas del proveedor en:{" "}
          {mismatched
            .map((month) => `${formatPeriod(month.period)} (reparto ${month.poolTotal}, facturas ${month.netTotal})`)
            .join(", ")}
          . Revisá si entró una factura o nota de crédito después de repartir.
        </p>
      ) : null}

      {pools.length === 0 ? (
        <TableCard>
          <tbody>
            <tr>
              <td>
                <EmptyState message="No hay pools de costo todavía. Cargá el monto neto (sin IVA) de la factura del proveedor (ej. licencias MS) para poder repartirlo." />
              </td>
            </tr>
          </tbody>
        </TableCard>
      ) : (
        <TableCard>
          <thead>
            <tr>
              <Th>Tipo de servicio</Th>
              <Th>Período</Th>
              <Th align="right">Monto neto</Th>
              <Th>Proveedor</Th>
              <Th>Estado</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {pools.map((pool) => (
              <Tr key={pool.id}>
                <Td className="font-medium text-[var(--color-ink)]">
                  {SERVICE_TYPE_LABELS[pool.service_type as ServiceType] ?? pool.service_type}
                </Td>
                <Td className="text-[var(--color-ink-2)]">{formatPeriod(pool.period)}</Td>
                <Td align="right">
                  <Money value={pool.total_expense_amount} currency={pool.currency} showCurrency={false} />
                </Td>
                <Td className="text-[var(--color-ink-2)]">
                  {pool.supplier_name ?? "Sin especificar"}
                </Td>
                <Td>
                  <span className="flex items-center gap-1.5 text-[12.5px]">
                    <StatusDot status={pool.is_allocated ? "active" : "warning"} />
                    <span
                      className={
                        pool.is_allocated
                          ? "text-[var(--color-accent-strong)]"
                          : "text-[var(--color-muted)]"
                      }
                    >
                      {pool.is_allocated ? "Repartido" : "Sin repartir"}
                    </span>
                  </span>
                </Td>
                <Td align="right">
                  <Link
                    href={`/companies/${id}/costs/ms-licenses/${pool.id}`}
                    className="text-[12.5px] font-medium text-[var(--color-accent-strong)]"
                  >
                    Ver
                  </Link>
                </Td>
              </Tr>
            ))}
          </tbody>
        </TableCard>
      )}
    </div>
  );
}
