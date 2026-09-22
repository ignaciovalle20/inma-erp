import { redirect } from "next/navigation";
import {
  getSession,
  getCompanyForEdit,
  getRecurringServiceCostPoolForDetail,
  getRecurringServiceCostAllocations,
} from "@/lib/dal";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/Card";
import { Money } from "@/components/Money";
import { TableCard, Th, Td, Tr } from "@/components/Table";
import { AllocateButton } from "./allocate-button";
import { SERVICE_TYPE_LABELS, type ServiceType } from "@/lib/recurringServiceTypes";

function formatPeriod(period: string): string {
  const [year, month] = period.split("-");
  const MONTH_LABELS = [
    "ene", "feb", "mar", "abr", "may", "jun",
    "jul", "ago", "sep", "oct", "nov", "dic",
  ];
  return `${MONTH_LABELS[Number(month) - 1]} ${year}`;
}

function SummaryField({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] uppercase tracking-[0.08em] text-[var(--color-muted)]">
        {label}
      </span>
      <span className="text-[13.5px] text-[var(--color-ink)]">{value}</span>
    </div>
  );
}

export default async function CostPoolDetailPage({
  params,
}: {
  params: Promise<{ id: string; costPoolId: string }>;
}) {
  const { id, costPoolId } = await params;
  const user = await getSession();

  if (!user) {
    redirect("/login");
  }

  const membership = await getCompanyForEdit(id);

  if (!membership) {
    redirect("/companies");
  }

  const pool = await getRecurringServiceCostPoolForDetail(id, costPoolId);

  if (!pool) {
    redirect(`/companies/${id}/recurring-services/cost-pools`);
  }

  const allocations = await getRecurringServiceCostAllocations(costPoolId);
  const allocatedTotal = allocations.reduce((sum, row) => sum + row.allocated_amount, 0);

  return (
    <div className="flex flex-col gap-[18px]">
      <PageHeader
        eyebrow="CONFIGURACIÓN / SERVICIOS RECURRENTES"
        title={`${SERVICE_TYPE_LABELS[pool.service_type as ServiceType] ?? pool.service_type} -- ${formatPeriod(pool.period)}`}
        subtitle={membership.company.name}
        back={{
          href: `/companies/${id}/recurring-services/cost-pools`,
          label: "Pools de costo",
        }}
      />

      <Card>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <SummaryField
            label="Monto total factura"
            value={<Money value={pool.total_expense_amount} currency={pool.currency} />}
          />
          <SummaryField label="Proveedor" value={pool.supplier_name ?? "Sin especificar"} />
          <SummaryField label="Período" value={formatPeriod(pool.period)} />
          <SummaryField
            label="Estado"
            value={allocations.length > 0 ? "Repartido" : "Sin repartir"}
          />
        </div>
      </Card>

      {allocations.length === 0 ? (
        <Card>
          <div className="flex flex-col items-start gap-3">
            <p className="text-[13px] text-[var(--color-muted)]">
              Todavía no se repartió este pool. Al repartir, el monto total se
              divide proporcionalmente entre lo facturado a cada cliente ese
              período (mismo tipo de servicio y moneda).
            </p>
            <AllocateButton companyId={id} costPoolId={pool.id} />
          </div>
        </Card>
      ) : (
        <TableCard>
          <thead>
            <tr>
              <Th>Cliente</Th>
              <Th>Servicio</Th>
              <Th align="right">Facturado al cliente</Th>
              <Th align="right">Costo asignado</Th>
            </tr>
          </thead>
          <tbody>
            {allocations.map((allocation) => (
              <Tr key={allocation.id}>
                <Td className="font-medium text-[var(--color-ink)]">
                  {allocation.client_name ?? "Cliente desconocido"}
                </Td>
                <Td className="text-[var(--color-ink-2)]">{allocation.service_name}</Td>
                <Td align="right">
                  <Money
                    value={allocation.occurrence_amount}
                    currency={allocation.currency}
                    showCurrency={false}
                  />
                </Td>
                <Td align="right">
                  <Money
                    value={allocation.allocated_amount}
                    currency={allocation.currency}
                    showCurrency={false}
                  />
                </Td>
              </Tr>
            ))}
            <Tr className="hover:bg-transparent">
              <Td className="font-semibold text-[var(--color-ink)]" colSpan={3}>
                Total repartido
              </Td>
              <Td align="right" className="font-semibold text-[var(--color-ink)]">
                <Money value={allocatedTotal} currency={pool.currency} showCurrency={false} />
              </Td>
            </Tr>
          </tbody>
        </TableCard>
      )}
    </div>
  );
}
