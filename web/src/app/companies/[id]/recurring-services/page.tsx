import Link from "next/link";
import { redirect } from "next/navigation";
import {
  getSession,
  getCompanyForEdit,
  getRecurringServices,
  getGeneratedRecurringServicePeriods,
  type RecurringServicePeriodicity,
} from "@/lib/dal";
import { GenerateButton } from "./generate-button";
import { PageHeader } from "@/components/PageHeader";
import { LinkButton } from "@/components/Button";
import { StatusDot } from "@/components/StatusDot";
import { Money } from "@/components/Money";
import { TableCard, Th, Td, Tr } from "@/components/Table";
import { EmptyState } from "@/components/EmptyState";

function currentPeriodStart(periodicity: RecurringServicePeriodicity): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const periodDate =
    periodicity === "annual" ? new Date(year, 0, 1) : new Date(year, month, 1);
  const yyyy = periodDate.getFullYear();
  const mm = String(periodDate.getMonth() + 1).padStart(2, "0");
  const dd = String(periodDate.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export default async function RecurringServicesPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await getSession();

  if (!user) {
    redirect("/login");
  }

  // Any membership (any role) is enough to view a company's recurring
  // services -- getCompanyForEdit doubles as the membership check here.
  const membership = await getCompanyForEdit(id);

  if (!membership) {
    redirect("/companies");
  }

  const services = await getRecurringServices(id);
  const generatedPeriods = await getGeneratedRecurringServicePeriods(
    id,
    services.map((service) => service.id),
  );

  return (
    <div className="flex flex-col gap-[18px]">
      <PageHeader
        eyebrow="MAESTROS / SERVICIOS RECURRENTES"
        title="Servicios recurrentes"
        subtitle={membership.company.name}
        actions={
          <LinkButton href={`/companies/${id}/recurring-services/new`} variant="primary">
            Nuevo servicio
          </LinkButton>
        }
      />

      {services.length === 0 ? (
        <TableCard>
          <tbody>
            <tr>
              <td>
                <EmptyState message="No hay servicios recurrentes todavía para esta empresa." />
              </td>
            </tr>
          </tbody>
        </TableCard>
      ) : (
        <TableCard>
          <thead>
            <tr>
              <Th>Servicio</Th>
              <Th>Cliente</Th>
              <Th align="right">Precio</Th>
              <Th align="right">Costo esperado</Th>
              <Th>Periodicidad</Th>
              <Th>Estado</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {services.map((service) => {
              const period = currentPeriodStart(service.periodicity);
              const alreadyGenerated = generatedPeriods.has(
                `${service.id}|${period}`,
              );
              const withinValidity =
                period >= service.start_date &&
                (!service.end_date || period <= service.end_date);
              const canGenerate =
                service.active && withinValidity && !alreadyGenerated;

              return (
                <Tr key={service.id}>
                  <Td className="font-medium text-[var(--color-ink)]">
                    {service.name}
                    <span className="block text-[11px] font-normal text-[var(--color-faint)]">
                      {service.start_date} → {service.end_date ?? "sin fin"}
                    </span>
                  </Td>
                  <Td className="text-[var(--color-ink-2)]">
                    {service.client_name ?? "Cliente desconocido"}
                  </Td>
                  <Td align="right">
                    <Money value={service.price} currency={service.currency} showCurrency={false} />
                  </Td>
                  <Td align="right" className="text-[var(--color-muted)]">
                    <Money value={service.expected_cost} currency={service.currency} showCurrency={false} />
                  </Td>
                  <Td className="text-[var(--color-ink-2)]">
                    {service.periodicity === "monthly" ? "Mensual" : "Anual"}
                  </Td>
                  <Td>
                    <span className="flex items-center gap-1.5 text-[12.5px]">
                      <StatusDot status={service.active ? "active" : "inactive"} />
                      <span
                        className={
                          service.active
                            ? "text-[var(--color-accent-strong)]"
                            : "text-[var(--color-muted)]"
                        }
                      >
                        {service.active ? "Activo" : "Inactivo"}
                      </span>
                    </span>
                  </Td>
                  <Td align="right">
                    <div className="flex items-center justify-end gap-3">
                      {canGenerate ? (
                        <GenerateButton
                          companyId={id}
                          recurringServiceId={service.id}
                          periodicity={service.periodicity}
                        />
                      ) : null}
                      <Link
                        href={`/companies/${id}/recurring-services/${service.id}/edit`}
                        className="text-[12.5px] font-medium text-[var(--color-accent-strong)]"
                      >
                        Editar
                      </Link>
                    </div>
                  </Td>
                </Tr>
              );
            })}
          </tbody>
        </TableCard>
      )}
    </div>
  );
}
