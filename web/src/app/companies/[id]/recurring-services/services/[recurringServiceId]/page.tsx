import { redirect } from "next/navigation";
import {
  getSession,
  getCompanyForEdit,
  getRecurringServices,
  getRecurringServiceOccurrenceHistory,
} from "@/lib/dal";
import { PageHeader } from "@/components/PageHeader";
import { LinkButton } from "@/components/Button";
import { Card } from "@/components/Card";
import { Money } from "@/components/Money";
import { EmptyState } from "@/components/EmptyState";
import {
  INVOICING_MODE_LABELS,
  RECURRING_SERVICE_STATUS_LABELS,
  SERVICE_COUNTRY_LABELS,
  SERVICE_TYPE_LABELS,
  serviceCountry,
  type InvoicingMode,
  type RecurringServiceStatus,
  type ServiceCountry,
  type ServiceType,
} from "@/lib/recurringServiceTypes";
import {
  boardMonthOf,
  cyclesBeforeStart,
  needsLinkReview,
  todayForCountry,
  totalsByCurrency,
} from "@/lib/recurringServicePending";
import { OccurrenceCard } from "../../occurrence-card";
import { BulkMarkBar, VoidBeforeStartButton } from "./history-tools";

const MONTH_NAMES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--color-muted)]">{label}</dt>
      <dd className="text-[13px] text-[var(--color-ink)]">{children}</dd>
    </div>
  );
}

/** One service: its contract terms and the history of every billing cycle with its state. */
export default async function RecurringServiceDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; recurringServiceId: string }>;
  searchParams: Promise<{ ciclos?: string; vinculados?: string; revisar?: string; sync?: string }>;
}) {
  const { id, recurringServiceId } = await params;
  const sp = await searchParams;
  const user = await getSession();

  if (!user) {
    redirect("/login");
  }

  const [membership, services, history] = await Promise.all([
    getCompanyForEdit(id),
    getRecurringServices(id),
    getRecurringServiceOccurrenceHistory(id, recurringServiceId),
  ]);
  const service = services.find((s) => s.id === recurringServiceId);

  if (!membership || !service) {
    redirect(`/companies/${id}/recurring-services/services`);
  }

  const today = todayForCountry(membership.company.country);
  const country = serviceCountry(membership.company.country);
  const storedCountry = service.country as ServiceCountry | null;
  const totals = totalsByCurrency(history);
  const currentMonth = today.slice(0, 7);
  // Moving the start date forward never deletes cycles: say how many are
  // left before it, and offer to void the ones not collected.
  const beforeStart = cyclesBeforeStart(history, service.start_date, service.periodicity);
  const toReview = history.filter(needsLinkReview).length;
  const bulkMonths = [...new Set(history.map((o) => boardMonthOf(o)))].sort().reverse();
  const bulkDefault = bulkMonths.find((m) => m <= currentMonth) ?? bulkMonths[bulkMonths.length - 1] ?? currentMonth;
  const synced =
    sp.ciclos !== undefined
      ? { created: Number(sp.ciclos) || 0, linked: Number(sp.vinculados) || 0, review: Number(sp.revisar) || 0 }
      : null;

  const modality =
    service.periodicity === "annual"
      ? "Anual"
      : `Mensual · mes ${service.invoicing_mode === "advance" ? "adelantado" : "vencido"}`;
  const dueDescription =
    service.due_day === null
      ? "Sin vencimiento definido (se usa el día 1)"
      : service.periodicity === "annual" && service.due_month !== null
        ? `El ${service.due_day} de ${MONTH_NAMES[service.due_month - 1]}`
        : `El día ${service.due_day}${service.invoicing_mode === "arrears" ? " del mes siguiente" : ""}`;

  return (
    <div className="flex flex-col gap-[18px]">
      <PageHeader
        eyebrow="GESTIÓN / SERVICIOS RECURRENTES / SERVICIO"
        title={service.name}
        subtitle={service.client_name ?? "Cliente desconocido"}
        back={{ href: `/companies/${id}/recurring-services/services`, label: "Servicios" }}
        actions={
          <LinkButton
            href={`/companies/${id}/recurring-services/services/${service.id}/edit`}
            variant="secondary"
          >
            Editar servicio
          </LinkButton>
        }
      />

      {synced ? (
        <p role="status" className="rounded-lg bg-[var(--color-accent-soft)] px-3 py-2 text-[12.5px] text-[var(--color-accent-strong)]">
          {synced.created === 0
            ? "No faltaba ningún ciclo desde el inicio."
            : `Se generaron ${synced.created} ${synced.created === 1 ? "ciclo" : "ciclos"} desde el inicio del servicio.`}
          {synced.linked > 0 ? ` ${synced.linked} quedaron vinculados a facturas ya importadas.` : ""}
          {synced.review > 0 ? ` ${synced.review} para revisar vínculo.` : ""}
        </p>
      ) : null}
      {sp.sync === "error" ? (
        <p role="alert" className="text-[12.5px] text-[var(--color-negative-ink)]">
          El servicio se guardó, pero no se pudieron generar sus ciclos anteriores. Abrí el tablero o volvé a guardar.
        </p>
      ) : null}

      <Card>
        <dl className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <Detail label="Monto">
            <Money value={service.price} currency={service.currency} />
          </Detail>
          <Detail label="Modalidad">
            {modality}
            {service.periodicity === "annual" ? (
              <span className="block text-[11.5px] text-[var(--color-muted)]">
                {INVOICING_MODE_LABELS[service.invoicing_mode as InvoicingMode] ?? service.invoicing_mode}
              </span>
            ) : null}
          </Detail>
          <Detail label="Vencimiento">{dueDescription}</Detail>
          <Detail label="Estado">
            {RECURRING_SERVICE_STATUS_LABELS[service.status as RecurringServiceStatus] ?? service.status}
          </Detail>
          <Detail label="Tipo">
            {service.service_type
              ? (SERVICE_TYPE_LABELS[service.service_type as ServiceType] ?? service.service_type)
              : "Sin especificar"}
          </Detail>
          <Detail label="País">{storedCountry ? SERVICE_COUNTRY_LABELS[storedCountry] : "—"}</Detail>
          <Detail label="Factura">{service.requires_invoice ? "Requiere factura" : "Sin factura"}</Detail>
          <Detail label="Vigencia">
            {service.start_date} → {service.end_date ?? "sin fin"}
          </Detail>
          {service.quote_ref ? <Detail label="COT#">{service.quote_ref}</Detail> : null}
          {service.notes ? (
            <div className="col-span-2 md:col-span-4">
              <Detail label="Detalle / notas">
                <span className="whitespace-pre-line">{service.notes}</span>
              </Detail>
            </div>
          ) : null}
        </dl>
      </Card>

      <section className="flex flex-col gap-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-[12.5px] font-semibold uppercase tracking-[0.08em] text-[var(--color-muted)]">
            Historial de períodos <span className="font-normal">· {history.length}</span>
          </h2>
          <p className="flex flex-wrap gap-3 text-[12px] text-[var(--color-ink-2)]">
            {totals.map((row) => (
              <span key={row.currency}>
                Cobrado <Money value={row.collected} currency={row.currency} /> · sin cobrar{" "}
                <Money value={row.toInvoice + row.toCollect} currency={row.currency} />
              </span>
            ))}
          </p>
        </div>
        {beforeStart.all.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2 rounded-lg bg-[var(--color-warning-soft)] px-3 py-2 text-[12.5px] text-[var(--color-warning-ink)]">
            <span>
              {beforeStart.all.length} {beforeStart.all.length === 1 ? "ciclo quedó" : "ciclos quedaron"} antes del
              inicio ({service.start_date}){beforeStart.open.length > 0 ? `, ${beforeStart.open.length} sin cobrar` : ""}.
              No se borraron.
            </span>
            <VoidBeforeStartButton
              companyId={id}
              serviceId={service.id}
              openCount={beforeStart.open.length}
            />
          </div>
        ) : null}
        {toReview > 0 ? (
          <p className="text-[12.5px] text-[var(--color-warning-ink)]">
            {toReview} {toReview === 1 ? "ciclo" : "ciclos"} para revisar vínculo con una factura (abajo, marcados
            &quot;Revisar vínculo&quot;).
          </p>
        ) : null}
        <BulkMarkBar
          companyId={id}
          serviceId={service.id}
          cycles={history}
          months={bulkMonths}
          defaultMonth={bulkDefault}
        />
        {history.length === 0 ? (
          <div className="rounded-[10px] border border-[var(--color-hairline)] bg-[var(--color-surface)]">
            <EmptyState message="Todavía no hay ciclos generados para este servicio." />
          </div>
        ) : (
          <ul className="grid items-start gap-2 md:grid-cols-2 xl:grid-cols-3">
            {history.map((occurrence) => (
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
        )}
      </section>
    </div>
  );
}
