import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession, getCompanyForEdit, getRecurringServiceCostPools } from "@/lib/dal";
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

  const pools = await getRecurringServiceCostPools(id);

  return (
    <div className="flex flex-col gap-[18px]">
      <PageHeader
        eyebrow="CONFIGURACIÓN / SERVICIOS RECURRENTES"
        title="Pools de costo"
        subtitle={membership.company.name}
        back={{
          href: `/companies/${id}/recurring-services`,
          label: "Servicios recurrentes",
        }}
        actions={
          <LinkButton
            href={`/companies/${id}/recurring-services/cost-pools/new`}
            variant="primary"
          >
            Nuevo pool
          </LinkButton>
        }
      />

      {pools.length === 0 ? (
        <TableCard>
          <tbody>
            <tr>
              <td>
                <EmptyState message="No hay pools de costo todavía. Cargá la factura del proveedor (ej. licencias MS) para poder repartirla." />
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
              <Th align="right">Monto total</Th>
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
                    href={`/companies/${id}/recurring-services/cost-pools/${pool.id}`}
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
