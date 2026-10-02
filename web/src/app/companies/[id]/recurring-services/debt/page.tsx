import { redirect } from "next/navigation";
import {
  getSession,
  getCompanyForEdit,
  getPendingRecurringServiceOccurrences,
} from "@/lib/dal";
import { PageHeader } from "@/components/PageHeader";
import { LinkButton } from "@/components/Button";
import { Money } from "@/components/Money";
import { EmptyState } from "@/components/EmptyState";
import { serviceCountry } from "@/lib/recurringServiceTypes";
import {
  debtByClient,
  describeAge,
  relevantDueDate,
  todayForCountry,
  totalsByCurrency,
} from "@/lib/recurringServicePending";
import { RecurringServicesNav } from "../nav";
import { OccurrenceCard } from "../occurrence-card";

/**
 * Deuda: every cycle not yet collected, from any month, grouped by
 * client (oldest debt first) with how long each has been due. Totals
 * are per currency, never added across CLP / USD / UYU.
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
  const clients = debtByClient(occurrences);
  const totals = totalsByCurrency(occurrences);

  return (
    <div className="flex flex-col gap-[18px]">
      <PageHeader
        eyebrow="SERVICIOS RECURRENTES / DEUDA"
        title="Servicios recurrentes"
        subtitle={membership.company.name}
        actions={
          <LinkButton href={`/companies/${id}/recurring-services/new`} variant="primary">
            Nuevo servicio
          </LinkButton>
        }
      />

      <RecurringServicesNav companyId={id} active="debt" debtCount={occurrences.length} />

      {totals.length > 0 ? (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {totals.map((row) => (
            <div
              key={row.currency}
              className="flex flex-col gap-1.5 rounded-[10px] border border-[var(--color-hairline)] bg-[var(--color-surface)] p-3"
            >
              <p className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-[var(--color-muted)]">
                Deuda total · {row.currency}
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
          <EmptyState message="No hay ciclos sin cobrar. Todo al día." />
        </div>
      ) : (
        clients.map((client) => {
          const oldestDue = relevantDueDate(client.rows[0]);
          return (
            <section key={client.clientId ?? "none"} className="flex flex-col gap-2">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-[14px] font-semibold text-[var(--color-ink)]">
                  {client.clientName}{" "}
                  <span className="text-[12px] font-normal text-[var(--color-muted)]">
                    · {client.rows.length} {client.rows.length === 1 ? "ciclo" : "ciclos"} · el más antiguo{" "}
                    {describeAge(oldestDue, today)}
                  </span>
                </h2>
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
                    companyId={id}
                    occurrence={occurrence}
                    today={today}
                    country={country}
                    showClient={false}
                  />
                ))}
              </ul>
            </section>
          );
        })
      )}
    </div>
  );
}
