import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession, getCompanyForEdit, getRecurringServices } from "@/lib/dal";
import {
  getCostPeriods,
  getCostServiceAllocations,
  getSupplierDocumentsForMonth,
  supplierNames,
} from "@/lib/costServiceAllocations";
import { formatPeriod } from "@/lib/period";
import { formatDisplayDate } from "@/lib/paymentStatus";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/Card";
import { Money } from "@/components/Money";
import { EmptyState } from "@/components/EmptyState";
import { TableCard, Th, Td, Tr } from "@/components/Table";

/**
 * One cost period of a service: the invoices allocated to it, and the
 * supplier's purchase invoices of that month still free to allocate --
 * each one opens "Asignar a servicios" with this period chosen.
 */
export default async function ServiceCostPeriodPage({
  params,
}: {
  params: Promise<{ id: string; recurringServiceId: string; costPeriodId: string }>;
}) {
  const { id, recurringServiceId, costPeriodId } = await params;
  const user = await getSession();

  if (!user) {
    redirect("/login");
  }

  const [membership, services, periods, suppliers] = await Promise.all([
    getCompanyForEdit(id),
    getRecurringServices(id),
    getCostPeriods(id, { periodIds: [costPeriodId] }),
    supplierNames(id),
  ]);
  const service = services.find((s) => s.id === recurringServiceId);
  const period = periods[0];
  const serviceHref = `/companies/${id}/recurring-services/services/${recurringServiceId}`;

  if (!membership || !service || !period || period.recurringServiceId !== recurringServiceId) {
    redirect(serviceHref);
  }

  const month = period.period.slice(0, 7);
  const [allocations, documents] = await Promise.all([
    getCostServiceAllocations(id, { periodIds: [costPeriodId] }),
    service.supplier_id ? getSupplierDocumentsForMonth(id, service.supplier_id, month) : Promise.resolve([]),
  ]);
  const allocatedIds = new Set(allocations.map((row) => row.costDocumentId));
  const free = documents.filter((doc) => !allocatedIds.has(doc.id));
  const supplierName = service.supplier_id ? (suppliers.get(service.supplier_id) ?? "Proveedor") : null;

  return (
    <div className="mx-auto flex w-full max-w-[700px] flex-col gap-5">
      <PageHeader
        eyebrow="GESTIÓN / SERVICIOS RECURRENTES / COSTO"
        title={`Costo de ${formatPeriod(period.period)}`}
        subtitle={`${service.name} · ${supplierName ?? "sin proveedor"}`}
        back={{ href: serviceHref, label: service.name }}
      />

      <Card className="flex flex-wrap items-baseline justify-between gap-3">
        <div className="flex flex-col gap-1">
          <span className="caps-label text-[var(--color-muted)]">Esperado</span>
          <Money value={period.expected} currency={period.currency} className="text-[20px] font-semibold" />
        </div>
        <div className="flex flex-col items-end gap-1">
          <span className="caps-label text-[var(--color-muted)]">Con factura</span>
          <Money value={period.invoiced} currency={period.currency} className="text-[16px] font-semibold" />
        </div>
      </Card>

      <section className="flex flex-col gap-2">
        <h2 className="caps-label text-[var(--color-muted)]">Facturas asignadas</h2>
        {allocations.length === 0 ? (
          <p className="text-[12.5px] text-[var(--color-muted)]">
            Ninguna: el período cuenta por su costo esperado.
          </p>
        ) : (
          <TableCard>
            <tbody>
              {allocations.map((row) => (
                <Tr key={row.id}>
                  <Td className="font-mono text-[12.5px]">{formatDisplayDate(row.documentDate)}</Td>
                  <Td>{row.status === "suggested" ? "Sugerida" : "Confirmada"}</Td>
                  <Td align="right">
                    <Money value={row.amount} currency={row.documentCurrency} />
                  </Td>
                  <Td align="right">
                    <Link
                      href={`/companies/${id}/costs/${row.costDocumentId}/services`}
                      className="text-[12.5px] font-medium text-[var(--color-accent-strong)]"
                    >
                      Editar
                    </Link>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </TableCard>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="caps-label text-[var(--color-muted)]">
          Facturas de {supplierName ?? "su proveedor"} de {formatPeriod(period.period)}
        </h2>
        {!service.supplier_id ? (
          <p className="text-[12.5px] text-[var(--color-muted)]">El servicio no tiene proveedor.</p>
        ) : free.length === 0 ? (
          <div className="rounded-[10px] border border-[var(--color-hairline)] bg-[var(--color-surface)]">
            <EmptyState message="No hay facturas de compra de este proveedor en el mes que se puedan asignar." />
          </div>
        ) : (
          <TableCard>
            <thead>
              <tr>
                <Th>Fecha</Th>
                <Th align="right">Neto</Th>
                <Th align="right">Ya en servicios</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {free.map((doc) => (
                <Tr key={doc.id}>
                  <Td className="font-mono text-[12.5px]">{formatDisplayDate(doc.documentDate)}</Td>
                  <Td align="right">
                    <Money value={doc.netAmount} currency={doc.currency} />
                  </Td>
                  <Td align="right">
                    <Money value={doc.serviceAllocated} currency={doc.currency} showCurrency={false} />
                  </Td>
                  <Td align="right">
                    <Link
                      href={`/companies/${id}/costs/${doc.id}/services?period=${period.id}`}
                      className="text-[12.5px] font-medium text-[var(--color-accent-strong)]"
                    >
                      Asignar a este período
                    </Link>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </TableCard>
        )}
      </section>
    </div>
  );
}
