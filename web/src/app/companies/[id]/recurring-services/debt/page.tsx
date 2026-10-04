import { redirect } from "next/navigation";
import {
  getSession,
  getCompanyForEdit,
  getPendingRecurringServiceOccurrences,
  type RecurringServiceOccurrenceRow,
} from "@/lib/dal";
import { PageHeader } from "@/components/PageHeader";
import { LinkButton } from "@/components/Button";
import { Money } from "@/components/Money";
import { EmptyState } from "@/components/EmptyState";
import { serviceCountry, type ServiceCountry } from "@/lib/recurringServiceTypes";
import {
  debtByClient,
  describeAge,
  relevantDueDate,
  splitByOverdue,
  todayForCountry,
  totalsByCurrency,
} from "@/lib/recurringServicePending";
import { RecurringServicesNav } from "../nav";
import { OccurrenceCard } from "../occurrence-card";

/**
 * Deuda: every cycle not yet collected, from any month, in two blocks --
 * "Vencido" (due before today) and "Por vencer" (the rest) -- each
 * grouped by client (oldest debt first) with how long each has been due.
 * Totals are per currency, never added across CLP / USD / UYU.
 */
export default async function RecurringServicesDebtPage({
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
  const country = serviceCountry(membership.company.country);
  const { overdue, upcoming } = splitByOverdue(occurrences, today);

  return (
    <div className="flex flex-col gap-[18px]">
      <PageHeader
        eyebrow="GESTIÓN / SERVICIOS RECURRENTES / DEUDA"
        title="Servicios recurrentes"
        subtitle={membership.company.name}
        actions={
          <LinkButton href={`/companies/${id}/recurring-services/services/new`} variant="primary">
            Nuevo servicio
          </LinkButton>
        }
      />

      <RecurringServicesNav companyId={id} active="debt" debtCount={occurrences.length} />

      {occurrences.length === 0 ? (
        <div className="rounded-[10px] border border-[var(--color-hairline)] bg-[var(--color-surface)]">
          <EmptyState message="No hay ciclos sin cobrar. Todo al día." />
        </div>
      ) : (
        <>
          <DebtBlock
            title="Vencido"
            tone="negative"
            occurrences={overdue}
            emptyMessage="Nada vencido."
            companyId={id}
            today={today}
            country={country}
          />
          <DebtBlock
            title="Por vencer"
            tone="neutral"
            occurrences={upcoming}
            emptyMessage="Nada por vencer."
            companyId={id}
            today={today}
            country={country}
          />
        </>
      )}
    </div>
  );
}

/** One Deuda block: per-currency totals, then the cycles grouped by client. */
function DebtBlock({
  title,
  tone,
  occurrences,
  emptyMessage,
  companyId,
  today,
  country,
}: {
  title: string;
  tone: "negative" | "neutral";
  occurrences: RecurringServiceOccurrenceRow[];
  emptyMessage: string;
  companyId: string;
  today: string;
  country: ServiceCountry | null;
}) {
  const clients = debtByClient(occurrences);
  const totals = totalsByCurrency(occurrences);
  const titleColor = tone === "negative" ? "text-[var(--color-negative-ink)]" : "text-[var(--color-ink)]";

  return (
    <section aria-label={title} className="flex flex-col gap-3">
      <h2 className={`text-[15px] font-semibold ${titleColor}`}>
        {title}{" "}
        <span className="text-[12px] font-normal text-[var(--color-muted)]">
          · {occurrences.length} {occurrences.length === 1 ? "ciclo" : "ciclos"}
        </span>
      </h2>

      {totals.length > 0 ? (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {totals.map((row) => (
            <div
              key={row.currency}
              className={`flex flex-col gap-1.5 rounded-[10px] border bg-[var(--color-surface)] p-3 ${
                tone === "negative" ? "border-[var(--color-negative-soft)]" : "border-[var(--color-hairline)]"
              }`}
            >
              <p className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-[var(--color-muted)]">
                {title} · {row.currency}
              </p>
              <dl className="grid grid-cols-2 gap-2 text-[12px]">
                <div>
                  <dt className="text-[var(--color-muted)]">Por facturar</dt>
                  <dd className="font-medium">
                    <Money value={row.toInvoice} currency={row.currency} showCurrency={false} />
                  </dd>
                </div>
                <div>
                  <dt className="text-[var(--color-muted)]">Por cobrar</dt>
                  <dd className="font-medium text-[var(--color-warning-ink)]">
                    <Money value={row.toCollect} currency={row.currency} showCurrency={false} />
                  </dd>
                </div>
              </dl>
            </div>
          ))}
        </div>
      ) : null}

      {clients.length === 0 ? (
        <div className="rounded-[10px] border border-[var(--color-hairline)] bg-[var(--color-surface)]">
          <EmptyState message={emptyMessage} />
        </div>
      ) : (
        clients.map((client) => {
          const oldestDue = relevantDueDate(client.rows[0]);
          return (
            <div key={client.clientId ?? "none"} className="flex flex-col gap-2">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="text-[14px] font-semibold text-[var(--color-ink)]">
                  {client.clientName}{" "}
                  <span className="text-[12px] font-normal text-[var(--color-muted)]">
                    · {client.rows.length} {client.rows.length === 1 ? "ciclo" : "ciclos"} · el más antiguo{" "}
                    {describeAge(oldestDue, today)}
                  </span>
                </h3>
                <p className="flex flex-wrap gap-3 text-[13px] font-medium">
                  {client.totals.map((total) => (
                    <Money key={total.currency} value={total.amount} currency={total.currency} />
                  ))}
                </p>
              </div>
              <ul className="grid items-start gap-2 md:grid-cols-2 xl:grid-cols-3">
                {client.rows.map((occurrence) => (
                  <OccurrenceCard
                    key={occurrence.id}
                    companyId={companyId}
                    occurrence={occurrence}
                    today={today}
                    country={country}
                    showClient={false}
                  />
                ))}
              </ul>
            </div>
          );
        })
      )}
    </section>
  );
}
