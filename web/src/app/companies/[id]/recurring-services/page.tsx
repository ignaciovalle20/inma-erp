import Link from "next/link";
import { redirect } from "next/navigation";
import {
  getSession,
  getCompanyForEdit,
  getRecurringServices,
  getPendingRecurringServiceOccurrences,
  type PendingRecurringServiceOccurrence,
  type RecurringServiceWithClient,
} from "@/lib/dal";
import { PageHeader } from "@/components/PageHeader";
import { LinkButton } from "@/components/Button";
import { StatusDot } from "@/components/StatusDot";
import { Badge } from "@/components/Badge";
import { Money } from "@/components/Money";
import { TableCard, Th, Td, Tr } from "@/components/Table";
import { EmptyState } from "@/components/EmptyState";
import {
  INVOICING_MODE_LABELS,
  RECURRING_SERVICE_STATUS_LABELS,
  type InvoicingMode,
  type RecurringServiceStatus,
} from "@/lib/recurringServiceTypes";
import {
  compareByDueDate,
  formatDueDate,
  groupByServiceType,
  isOverdue,
  nextActionLabel,
  relevantDueDate,
  todayForCountry,
} from "@/lib/recurringServicePending";

const MONTH_NAMES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

function describeDueDay(service: RecurringServiceWithClient): string {
  if (service.due_day === null) return "Sin día de vencimiento";
  if (service.periodicity === "annual" && service.due_month !== null) {
    return `Vence el ${service.due_day} de ${MONTH_NAMES[service.due_month - 1]}`;
  }
  return `Vence el día ${service.due_day}`;
}

/**
 * The Trello card badge: what's next for this service (Facturar /
 * Cobrar) and by when, red once overdue. Links to Pendientes, where the
 * one-tap action lives. "+N" when older periods are still open too.
 */
function NextStep({
  companyId,
  open,
  today,
}: {
  companyId: string;
  open: PendingRecurringServiceOccurrence[];
  today: string;
}) {
  if (open.length === 0) {
    return <span className="text-[12.5px] text-[var(--color-faint)]">Al día</span>;
  }

  const [next] = open;
  const overdue = isOverdue(next, today);

  return (
    <Link
      href={`/companies/${companyId}/recurring-services/pending`}
      className="inline-flex flex-wrap items-center gap-1.5"
    >
      <Badge variant={next.status === "invoiced" ? "warning" : "neutral"}>
        {nextActionLabel(next.status)}
      </Badge>
      <span
        className={`text-[12.5px] ${
          overdue ? "font-medium text-[var(--color-negative-ink)]" : "text-[var(--color-ink-2)]"
        }`}
      >
        {formatDueDate(relevantDueDate(next))}
      </span>
      {open.length > 1 ? (
        <span className="text-[11.5px] text-[var(--color-muted)]">+{open.length - 1}</span>
      ) : null}
    </Link>
  );
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

  const [services, pending] = await Promise.all([
    getRecurringServices(id),
    getPendingRecurringServiceOccurrences(id),
  ]);
  const today = todayForCountry(membership.company.country);

  const openByService = new Map<string, PendingRecurringServiceOccurrence[]>();
  for (const occurrence of [...pending].sort(compareByDueDate)) {
    const list = openByService.get(occurrence.recurring_service_id) ?? [];
    list.push(occurrence);
    openByService.set(occurrence.recurring_service_id, list);
  }

  const groups = groupByServiceType(services, (a, b) =>
    (a.client_name ?? "").localeCompare(b.client_name ?? "", "es") || a.name.localeCompare(b.name, "es"),
  );

  return (
    <div className="flex flex-col gap-[18px]">
      <PageHeader
        eyebrow="CONFIGURACIÓN / SERVICIOS RECURRENTES"
        title="Servicios recurrentes"
        subtitle={membership.company.name}
        actions={
          <>
            <LinkButton
              href={`/companies/${id}/recurring-services/cost-pools`}
              variant="secondary"
            >
              Pools de costo
            </LinkButton>
            <LinkButton
              href={`/companies/${id}/recurring-services/pending`}
              variant="secondary"
            >
              Pendientes{pending.length > 0 ? ` (${pending.length})` : ""}
            </LinkButton>
            <LinkButton href={`/companies/${id}/recurring-services/new`} variant="primary">
              Nuevo servicio
            </LinkButton>
          </>
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
        groups.map((group) => (
          <section key={group.type ?? "none"} className="flex flex-col gap-2">
            <h2 className="text-[12.5px] font-semibold uppercase tracking-[0.08em] text-[var(--color-muted)]">
              {group.label} <span className="font-normal">· {group.rows.length}</span>
            </h2>
            <TableCard>
              <thead>
                <tr>
                  <Th>Cliente</Th>
                  <Th align="right">Precio</Th>
                  <Th>Facturación</Th>
                  <Th>Estado</Th>
                  <Th>Próximo</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {group.rows.map((service) => {
                  const status = service.status as RecurringServiceStatus;
                  return (
                    <Tr key={service.id}>
                      <Td>
                        <span className="font-medium text-[var(--color-ink)]">
                          {service.client_name ?? "Cliente desconocido"}
                        </span>
                        <span className="block text-[12px] text-[var(--color-ink-2)]">
                          {service.name}
                        </span>
                        <span className="block text-[11px] text-[var(--color-faint)]">
                          {service.start_date} → {service.end_date ?? "sin fin"}
                        </span>
                      </Td>
                      <Td align="right">
                        <Money value={service.price} currency={service.currency} />
                      </Td>
                      <Td className="text-[12.5px] text-[var(--color-ink-2)]">
                        {service.periodicity === "monthly" ? "Mensual" : "Anual"} ·{" "}
                        {INVOICING_MODE_LABELS[service.invoicing_mode as InvoicingMode] ??
                          service.invoicing_mode}
                        <span className="block text-[11px] text-[var(--color-faint)]">
                          {describeDueDay(service)}
                        </span>
                      </Td>
                      <Td>
                        <span className="flex items-center gap-1.5 text-[12.5px]">
                          <StatusDot status={status === "active" ? "active" : "inactive"} />
                          <span
                            className={
                              status === "active"
                                ? "text-[var(--color-accent-strong)]"
                                : "text-[var(--color-muted)]"
                            }
                          >
                            {RECURRING_SERVICE_STATUS_LABELS[status] ?? service.status}
                          </span>
                        </span>
                      </Td>
                      <Td>
                        <NextStep
                          companyId={id}
                          open={openByService.get(service.id) ?? []}
                          today={today}
                        />
                      </Td>
                      <Td align="right">
                        <Link
                          href={`/companies/${id}/recurring-services/${service.id}/edit`}
                          className="text-[12.5px] font-medium text-[var(--color-accent-strong)]"
                        >
                          Editar
                        </Link>
                      </Td>
                    </Tr>
                  );
                })}
              </tbody>
            </TableCard>
          </section>
        ))
      )}
    </div>
  );
}
