import { redirect } from "next/navigation";
import {
  getSession,
  getCompanyForEdit,
  getPendingRecurringServiceOccurrences,
  type PendingRecurringServiceOccurrence,
} from "@/lib/dal";
import { PageHeader } from "@/components/PageHeader";
import { Money } from "@/components/Money";
import { Badge } from "@/components/Badge";
import { TableCard, Th, Td, Tr } from "@/components/Table";
import { EmptyState } from "@/components/EmptyState";
import { OccurrenceActions } from "./occurrence-actions";
import { OCCURRENCE_STATUS_LABELS } from "@/lib/recurringServiceTypes";
import {
  compareByDueDate,
  formatDueDate,
  formatPeriod,
  groupByServiceType,
  isOverdue,
  relevantDueDate,
  todayForCountry,
} from "@/lib/recurringServicePending";

function DueDate({ occurrence, today }: { occurrence: PendingRecurringServiceOccurrence; today: string }) {
  const overdue = isOverdue(occurrence, today);
  return (
    <span
      className={
        overdue ? "font-medium text-[var(--color-negative-ink)]" : "text-[var(--color-ink-2)]"
      }
    >
      {formatDueDate(relevantDueDate(occurrence))}
      {overdue ? " · vencido" : ""}
    </span>
  );
}

function StatusBadge({ status }: { status: PendingRecurringServiceOccurrence["status"] }) {
  return (
    <Badge variant={status === "invoiced" ? "warning" : "neutral"}>
      {OCCURRENCE_STATUS_LABELS[status]}
    </Badge>
  );
}

export default async function PendingRecurringServiceOccurrencesPage({
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

  const occurrences = await getPendingRecurringServiceOccurrences(id);
  const today = todayForCountry(membership.company.country);
  // Grouped like the old Trello columns (one per service type), each
  // sorted by the due date of its next action -- the reminder view.
  const groups = groupByServiceType(occurrences, compareByDueDate);

  return (
    <div className="flex flex-col gap-[18px]">
      <PageHeader
        eyebrow="CONFIGURACIÓN / SERVICIOS RECURRENTES"
        title="Pendientes"
        subtitle={membership.company.name}
        back={{
          href: `/companies/${id}/recurring-services`,
          label: "Servicios recurrentes",
        }}
      />

      {occurrences.length === 0 ? (
        <TableCard>
          <tbody>
            <tr>
              <td>
                <EmptyState message="No hay nada pendiente de facturar o cobrar." />
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

            {/* Phone: one card per pending item, big tap target. */}
            <ul className="flex flex-col gap-2 md:hidden">
              {group.rows.map((occurrence) => (
                <li
                  key={occurrence.id}
                  className="flex flex-col gap-2.5 rounded-[10px] border border-[var(--color-hairline)] bg-[var(--color-surface)] p-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-[14px] font-medium text-[var(--color-ink)]">
                        {occurrence.client_name ?? "Cliente desconocido"}
                      </p>
                      <p className="truncate text-[12.5px] text-[var(--color-ink-2)]">
                        {occurrence.service_name} ·{" "}
                        {formatPeriod(occurrence.period, occurrence.service_periodicity)}
                      </p>
                    </div>
                    <p className="shrink-0 text-[14px] font-medium">
                      <Money value={occurrence.amount} currency={occurrence.currency} />
                    </p>
                  </div>
                  <div className="flex items-center justify-between gap-3 text-[12.5px]">
                    <StatusBadge status={occurrence.status} />
                    <DueDate occurrence={occurrence} today={today} />
                  </div>
                  <OccurrenceActions
                    companyId={id}
                    occurrenceId={occurrence.id}
                    status={occurrence.status}
                  />
                </li>
              ))}
            </ul>

            {/* Desktop: the same rows as a table. */}
            <div className="hidden md:block">
              <TableCard>
                <thead>
                  <tr>
                    <Th>Cliente</Th>
                    <Th>Servicio</Th>
                    <Th>Período</Th>
                    <Th align="right">Monto</Th>
                    <Th>Vencimiento</Th>
                    <Th>Estado</Th>
                    <Th />
                  </tr>
                </thead>
                <tbody>
                  {group.rows.map((occurrence) => (
                    <Tr key={occurrence.id}>
                      <Td className="font-medium text-[var(--color-ink)]">
                        {occurrence.client_name ?? "Cliente desconocido"}
                      </Td>
                      <Td className="text-[var(--color-ink-2)]">{occurrence.service_name}</Td>
                      <Td className="text-[var(--color-ink-2)]">
                        {formatPeriod(occurrence.period, occurrence.service_periodicity)}
                      </Td>
                      <Td align="right">
                        <Money value={occurrence.amount} currency={occurrence.currency} />
                      </Td>
                      <Td>
                        <DueDate occurrence={occurrence} today={today} />
                      </Td>
                      <Td>
                        <StatusBadge status={occurrence.status} />
                      </Td>
                      <Td align="right">
                        <OccurrenceActions
                          companyId={id}
                          occurrenceId={occurrence.id}
                          status={occurrence.status}
                        />
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </TableCard>
            </div>
          </section>
        ))
      )}
    </div>
  );
}
