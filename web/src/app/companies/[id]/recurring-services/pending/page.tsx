import { redirect } from "next/navigation";
import {
  getSession,
  getCompanyForEdit,
  getPendingRecurringServiceOccurrences,
  type PendingRecurringServiceOccurrence,
} from "@/lib/dal";
import { PageHeader } from "@/components/PageHeader";
import { Money } from "@/components/Money";
import { TableCard, Th, Td, Tr } from "@/components/Table";
import { EmptyState } from "@/components/EmptyState";
import { OccurrenceActions } from "./occurrence-actions";
import {
  SERVICE_TYPES,
  SERVICE_TYPE_LABELS,
  OCCURRENCE_STATUS_LABELS,
  type ServiceType,
} from "@/lib/recurringServiceTypes";

const MONTH_LABELS = [
  "ene", "feb", "mar", "abr", "may", "jun",
  "jul", "ago", "sep", "oct", "nov", "dic",
];

function formatPeriod(period: string, periodicity: "monthly" | "annual"): string {
  // period is always the first day of its unit (see 20260913070000 /
  // 20260922040000) -- parsed as UTC-safe pieces from the raw
  // "YYYY-MM-DD" string, not `new Date(period)`, to avoid a timezone
  // shift landing on the wrong month.
  const [year, month] = period.split("-");
  if (periodicity === "annual") return year;
  return `${MONTH_LABELS[Number(month) - 1]} ${year}`;
}

function formatDate(value: string | null): string {
  if (!value) return "sin fecha";
  const [year, month, day] = value.split("-");
  return `${day}/${month}/${year}`;
}

// today's date as "YYYY-MM-DD", comparable to invoice_due_date/
// collection_due_date lexicographically (both are already that
// shape).
function todayIsoDate(): string {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function groupByServiceType(
  occurrences: PendingRecurringServiceOccurrence[],
): { type: ServiceType | null; label: string; rows: PendingRecurringServiceOccurrence[] }[] {
  const groups = new Map<ServiceType | null, PendingRecurringServiceOccurrence[]>();

  for (const occurrence of occurrences) {
    const key = (occurrence.service_type as ServiceType | null) ?? null;
    const bucket = groups.get(key) ?? [];
    bucket.push(occurrence);
    groups.set(key, bucket);
  }

  const orderedTypes: (ServiceType | null)[] = [...SERVICE_TYPES, null];

  return orderedTypes
    .filter((type) => groups.has(type))
    .map((type) => ({
      type,
      label: type ? SERVICE_TYPE_LABELS[type] : "Sin tipo especificado",
      rows: groups.get(type)!,
    }));
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
  const today = todayIsoDate();
  const groups = groupByServiceType(occurrences);

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
          <div key={group.type ?? "none"} className="flex flex-col gap-2">
            <h2 className="text-[12.5px] font-semibold uppercase tracking-[0.08em] text-[var(--color-muted)]">
              {group.label}
            </h2>
            <TableCard>
              <thead>
                <tr>
                  <Th>Servicio</Th>
                  <Th>Cliente</Th>
                  <Th>Período</Th>
                  <Th align="right">Monto</Th>
                  <Th>Vencimiento</Th>
                  <Th>Estado</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {group.rows.map((occurrence) => {
                  const dueDate =
                    occurrence.status === "invoiced"
                      ? occurrence.collection_due_date
                      : occurrence.invoice_due_date;
                  const isOverdue = dueDate !== null && dueDate < today;

                  return (
                    <Tr key={occurrence.id}>
                      <Td className="font-medium text-[var(--color-ink)]">
                        {occurrence.service_name}
                      </Td>
                      <Td className="text-[var(--color-ink-2)]">
                        {occurrence.client_name ?? "Cliente desconocido"}
                      </Td>
                      <Td className="text-[var(--color-ink-2)]">
                        {formatPeriod(occurrence.period, occurrence.service_periodicity)}
                      </Td>
                      <Td align="right">
                        <Money value={occurrence.amount} currency={occurrence.currency} showCurrency={false} />
                      </Td>
                      <Td
                        className={
                          isOverdue
                            ? "font-medium text-[var(--color-negative-ink)]"
                            : "text-[var(--color-ink-2)]"
                        }
                      >
                        {formatDate(dueDate)}
                      </Td>
                      <Td className="text-[var(--color-ink-2)]">
                        {OCCURRENCE_STATUS_LABELS[occurrence.status]}
                      </Td>
                      <Td align="right">
                        <OccurrenceActions
                          companyId={id}
                          occurrenceId={occurrence.id}
                          status={occurrence.status}
                        />
                      </Td>
                    </Tr>
                  );
                })}
              </tbody>
            </TableCard>
          </div>
        ))
      )}
    </div>
  );
}
