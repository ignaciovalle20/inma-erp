import Link from "next/link";
import { redirect } from "next/navigation";
import {
  getSession,
  getCompanyForEdit,
  getCostDocumentDetail,
  getCostAllocations,
  type CostAllocationTargetType,
} from "@/lib/dal";
import { allocationTotals, rowShare, serviceGrossAmounts } from "@/lib/allocations";
import { currencyDecimals } from "@/lib/currencies";
import { getCostPeriods, getCostServiceAllocations } from "@/lib/costServiceAllocations";
import { formatPeriod } from "@/lib/period";
import { ReassignPeriodForm } from "./reassign-period-form";
import { DeleteCostButton } from "../delete-cost-button";
import { getTechnicianChargeCostLinks } from "@/lib/technicianDal";
import { costDeletionSummary, technicianChargeHref } from "@/lib/costDocumentDeletion";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/Card";
import { Badge } from "@/components/Badge";
import { Money } from "@/components/Money";
import { LinkButton } from "@/components/Button";
import { EmptyState } from "@/components/EmptyState";
import { AllocationBar, allocationColor } from "@/components/AllocationBar";

const CLASSIFICATION_LABEL: Record<string, string> = {
  direct: "Directo",
  general: "General",
};

// Only an id shaped like a uuid is used to build the way back to a job.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TARGET_TYPE_LABEL: Record<CostAllocationTargetType, string> = {
  project: "Proyecto",
  client: "Cliente",
  business_area: "Área",
};

/**
 * Story 6.4: read-only detail page for a cost document -- deliberately
 * read-only, no edit form (see the spec's Design Notes for why building
 * cost-document editing is out of scope here). §1a redesign: header
 * badges + a totals card replace the old 8-row `<dl>`, and the
 * allocation summary (previously just a link out to /allocate) is
 * rendered inline with its own bar and per-target breakdown.
 */
export default async function CostDocumentDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; costDocumentId: string }>;
  searchParams: Promise<{ projectId?: string }>;
}) {
  const { id, costDocumentId } = await params;
  const { projectId: fromProjectId } = await searchParams;
  const user = await getSession();

  if (!user) {
    redirect("/login");
  }

  const membership = await getCompanyForEdit(id);

  if (!membership) {
    redirect("/companies");
  }

  const document = await getCostDocumentDetail(id, costDocumentId);

  if (!document) {
    redirect(`/companies/${id}/costs`);
  }

  const [allocations, serviceAllocations] =
    document.classification === "general"
      ? await Promise.all([
          getCostAllocations(costDocumentId),
          getCostServiceAllocations(id, { costDocumentId }),
        ])
      : [[], []];
  const [servicePeriods, [technicianCharge]] = await Promise.all([
    getCostPeriods(id, { periodIds: serviceAllocations.map((row) => row.costPeriodId) }),
    getTechnicianChargeCostLinks(id, costDocumentId).catch((thrown) => {
      console.error(thrown);
      return [];
    }),
  ]);
  const servicePeriodById = new Map(servicePeriods.map((period) => [period.id, period]));
  const serviceAssigned = serviceAllocations
    .filter((row) => row.status === "confirmed")
    .reduce((sum, row) => sum + row.amount, 0);
  // "Asignar a servicios" is for an invoice that goes to services only; a
  // split one (with or without services) is edited from "Editar asignación".
  const canAssignToServices =
    document.classification === "general" &&
    !document.project_id &&
    allocations.length === 0 &&
    !document.covered_by_cost_pool_id;
  // Mixed (20261025010000): part to services, part split; together, the total.
  const mixed = allocations.length > 0 && serviceAssigned > 0;
  const servicesGross = mixed
    ? serviceGrossAmounts(
        serviceAllocations.filter((row) => row.status === "confirmed"),
        document.net_amount,
        document.total_amount,
        currencyDecimals(document.currency),
      ).reduce((sum, amount) => sum + amount, 0)
    : 0;

  const allocationRows = allocations.map((allocation) => ({
    method: allocation.method,
    value: String(
      allocation.method === "percentage"
        ? (allocation.percentage ?? 0)
        : (allocation.amount ?? 0),
    ),
  }));
  const totals = allocationTotals(
    [...allocationRows, ...(mixed ? [{ method: "fixed_amount" as const, value: String(servicesGross) }] : [])],
    document.total_amount,
  );

  const allocationSegments = [
    ...allocations.map((allocation, index) => {
      const share = rowShare(allocationRows[index], document.total_amount);
      return {
        label: allocation.target_name ?? TARGET_TYPE_LABEL[allocation.target_type],
        share: document.total_amount > 0 ? share / document.total_amount : 0,
        color: allocationColor(index).color,
      };
    }),
    ...(mixed
      ? [
          {
            label: "Servicios recurrentes",
            share: document.total_amount > 0 ? servicesGross / document.total_amount : 0,
            color: allocationColor(allocations.length).color,
          },
        ]
      : []),
  ];

  const allocationBadge =
    document.classification === "general" ? (
      serviceAllocations.length > 0 && !mixed ? (
        serviceAllocations.every((row) => row.status === "suggested") ? (
          <Badge variant="warning">Sugerido a servicios</Badge>
        ) : (
          <Badge variant="positive">Asignado a servicios</Badge>
        )
      ) : allocations.length === 0 ? (
        <Badge variant="warning">Sin asignar</Badge>
      ) : totals.matches ? (
        <Badge variant="positive">Asignado 100%</Badge>
      ) : (
        <Badge variant="warning">
          {`Falta ${
            document.total_amount > 0
              ? Math.round((totals.missing / document.total_amount) * 100)
              : 0
          }%`}
        </Badge>
      )
    ) : null;

  // Reached from a job's list of expenses, the way back is that job, not the
  // company-wide list of cost documents.
  const back =
    fromProjectId && UUID_PATTERN.test(fromProjectId)
      ? { href: `/companies/${id}/projects/${fromProjectId}`, label: "Volver al trabajo" }
      : { href: `/companies/${id}/costs`, label: "Volver a documentos de costo" };

  const recognizedPeriodLabel = document.recognized_period
    ? formatPeriod(document.recognized_period)
    : formatPeriod(`${document.document_date.slice(0, 7)}-01`);

  return (
    <div className="mx-auto flex w-full max-w-[700px] flex-col gap-5">
      <PageHeader
        eyebrow="GESTIÓN / COSTOS / DOCUMENTO"
        title="Documento de costo"
        subtitle={`${membership.company.name} · ${document.document_date}`}
        back={back}
        actions={
          <>
            <Badge variant={document.classification === "direct" ? "positive" : "neutral"}>
              {CLASSIFICATION_LABEL[document.classification] ?? document.classification}
            </Badge>
            {allocationBadge}
            {document.covered_by_cost_pool_id ? (
              <Link
                href={`/companies/${id}/costs/ms-licenses/${document.covered_by_cost_pool_id}`}
                className="no-underline"
              >
                <Badge variant="warning">Cubierto por pool</Badge>
              </Link>
            ) : null}
          </>
        }
      />

      {document.covered_by_cost_pool_id ? (
        <div className="rounded-lg border border-[var(--color-warning-soft-border)] bg-[var(--color-warning-soft)] px-3 py-2.5 text-[13px] text-[var(--color-warning-ink)]">
          Este documento es la factura de licencias MS de un mes que ya tiene su reparto de licencias:
          el costo ya está en ese reparto, así que este documento no suma al resultado mensual ni a la
          rentabilidad.{" "}
          <Link
            href={`/companies/${id}/costs/ms-licenses/${document.covered_by_cost_pool_id}`}
            className="font-medium text-[var(--color-warning-ink)] underline"
          >
            Ver el reparto
          </Link>
        </div>
      ) : null}

      <Card className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div className="flex flex-col gap-1">
            <span className="caps-label text-[var(--color-muted)]">
              {document.document_type === "credit_note" ? "Total (nota de crédito, resta)" : "Total"}
            </span>
            <Money
              value={document.total_amount}
              currency={document.currency}
              className="text-[22px] font-semibold text-[var(--color-ink)]"
            />
            {document.source_document_type || document.document_number ? (
              <span className="font-mono text-[11.5px] text-[var(--color-muted)]">
                {[document.source_document_type, document.document_number].filter(Boolean).join(" ")}
              </span>
            ) : null}
          </div>
          <div className="flex flex-col items-end gap-1 text-[12.5px] text-[var(--color-ink-2)]">
            <span>
              Neto{" "}
              <Money value={document.net_amount} currency={document.currency} showCurrency={false} />
            </span>
            {Number(document.exempt_amount ?? 0) !== 0 ? (
              <span>
                de los que exento{" "}
                <Money value={Number(document.exempt_amount)} currency={document.currency} showCurrency={false} />
              </span>
            ) : null}
            <span>
              IVA{" "}
              <Money value={document.tax_amount} currency={document.currency} showCurrency={false} />
            </span>
            {Number(document.other_taxes ?? 0) !== 0 ? (
              <span>
                Otros impuestos{" "}
                <Money value={Number(document.other_taxes)} currency={document.currency} showCurrency={false} />
              </span>
            ) : null}
          </div>
        </div>
        <div className="grid grid-cols-1 gap-3 border-t border-[var(--color-hairline)] pt-3 sm:grid-cols-3">
          <div className="flex flex-col gap-1">
            <span className="caps-label text-[var(--color-muted)]">
              Proveedor
            </span>
            <span className="text-[13px] text-[var(--color-ink)]">
              {document.supplier_name ?? "—"}
            </span>
          </div>
          <div className="flex flex-col gap-1">
            <span className="caps-label text-[var(--color-muted)]">
              Proyecto
            </span>
            <span className="text-[13px] text-[var(--color-ink)]">
              {document.project_name ?? "—"}
            </span>
          </div>
          <div className="flex flex-col gap-1">
            <span className="caps-label text-[var(--color-muted)]">
              Reconocido en
            </span>
            <span className="text-[13px] text-[var(--color-ink)]">
              {recognizedPeriodLabel}
            </span>
          </div>
        </div>
      </Card>

      {document.classification === "general" && (serviceAllocations.length > 0 || canAssignToServices) ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="caps-label text-[var(--color-muted)]">Servicios recurrentes</span>
            {mixed ? (
              <Link
                href={`/companies/${id}/costs/${document.id}/allocate`}
                className="text-[12.5px] font-medium text-[var(--color-accent-strong)]"
              >
                Editar asignación
              </Link>
            ) : canAssignToServices ? (
              <div className="flex gap-3">
                {serviceAssigned > 0 ? (
                  <Link
                    href={`/companies/${id}/costs/${document.id}/allocate`}
                    className="text-[12.5px] font-medium text-[var(--color-accent-strong)]"
                  >
                    Repartir también con trabajos
                  </Link>
                ) : null}
                <Link
                  href={`/companies/${id}/costs/${document.id}/services`}
                  className="text-[12.5px] font-medium text-[var(--color-accent-strong)]"
                >
                  {serviceAllocations.length > 0 ? "Editar asignación a servicios" : "Asignar a servicios"}
                </Link>
              </div>
            ) : null}
          </div>
          <Card className="flex flex-col gap-2">
            {serviceAllocations.length === 0 ? (
              <p className="text-[12.5px] text-[var(--color-muted)]">
                Si esta factura es el costo de servicios recurrentes (hosting, Starlink, dominios…), asignala a
                sus períodos de costo: reemplaza el costo fijo esperado y deja de contar como costo general.
              </p>
            ) : (
              <>
                <ul className="flex flex-col gap-2">
                  {serviceAllocations.map((row) => {
                    const period = servicePeriodById.get(row.costPeriodId);
                    return (
                      <li key={row.id} className="flex flex-wrap items-center gap-2.5 text-[12.5px]">
                        <span className="flex-1 truncate text-[var(--color-ink)]">
                          {period ? (
                            <Link
                              href={`/companies/${id}/recurring-services/services/${period.recurringServiceId}`}
                              className="text-[var(--color-ink)]"
                            >
                              {period.serviceName}
                            </Link>
                          ) : (
                            "Servicio"
                          )}
                          {period?.clientName ? (
                            <span className="text-[var(--color-muted)]"> · {period.clientName}</span>
                          ) : null}
                        </span>
                        <span className="text-[var(--color-ink-2)]">{period ? formatPeriod(period.period) : ""}</span>
                        {row.status === "suggested" ? <Badge variant="warning">Sugerida</Badge> : null}
                        <Money
                          value={row.amount}
                          currency={document.currency}
                          showCurrency={false}
                          className="font-medium text-[var(--color-ink)]"
                        />
                      </li>
                    );
                  })}
                </ul>
                <p className="border-t border-[var(--color-hairline-soft)] pt-2 text-[12px] text-[var(--color-ink-2)]">
                  Asignado a servicios <Money value={serviceAssigned} currency={document.currency} /> de{" "}
                  <Money value={document.net_amount} currency={document.currency} /> neto
                  {serviceAllocations.some((row) => row.status === "suggested")
                    ? " · las sugeridas se confirman en Conciliar o guardando la asignación."
                    : ""}
                </p>
              </>
            )}
          </Card>
        </div>
      ) : null}

      {document.classification === "general" && (serviceAllocations.length === 0 || mixed) ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="caps-label text-[var(--color-muted)]">
              Asignación
            </span>
            {allocations.length > 0 ? (
              <Link
                href={`/companies/${id}/costs/${document.id}/allocate`}
                className="text-[12.5px] font-medium text-[var(--color-accent-strong)]"
              >
                Editar asignación
              </Link>
            ) : null}
          </div>
          <Card className="flex flex-col gap-3">
            {allocations.length === 0 ? (
              <EmptyState
                message="Este costo general todavía no tiene un reparto definido."
                action={
                  <LinkButton
                    href={`/companies/${id}/costs/${document.id}/allocate`}
                    variant="secondary"
                  >
                    Asignar este costo
                  </LinkButton>
                }
              />
            ) : (
              <>
                <AllocationBar segments={allocationSegments} />
                <ul className="flex flex-col gap-2">
                  {allocations.map((allocation, index) => {
                    const share = rowShare(allocationRows[index], document.total_amount);
                    const pct =
                      document.total_amount > 0 ? (share / document.total_amount) * 100 : 0;
                    const { color, opacity } = allocationColor(index);
                    return (
                      <li
                        key={allocation.id}
                        className="flex items-center gap-2.5 text-[12.5px]"
                      >
                        <span
                          className="h-2 w-2 shrink-0 rounded-full"
                          style={{ backgroundColor: color, opacity }}
                        />
                        <span className="caps-label text-[var(--color-muted)]">
                          {TARGET_TYPE_LABEL[allocation.target_type]}
                        </span>
                        <span className="flex-1 truncate text-[var(--color-ink)]">
                          {allocation.target_name ?? "—"}
                        </span>
                        <span className="text-[var(--color-ink-2)]">{pct.toFixed(1).replace(".", ",")}%</span>
                        <Money
                          value={share}
                          currency={document.currency}
                          showCurrency={false}
                          className="font-medium text-[var(--color-ink)]"
                        />
                      </li>
                    );
                  })}
                  {mixed ? (
                    <li className="flex items-center gap-2.5 text-[12.5px]">
                      <span
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{
                          backgroundColor: allocationColor(allocations.length).color,
                          opacity: allocationColor(allocations.length).opacity,
                        }}
                      />
                      <span className="caps-label text-[var(--color-muted)]">Servicios</span>
                      <span className="flex-1 truncate text-[var(--color-ink)]">
                        Servicios recurrentes (detalle arriba)
                      </span>
                      <span className="text-[var(--color-ink-2)]">
                        {(document.total_amount > 0 ? (servicesGross / document.total_amount) * 100 : 0)
                          .toFixed(1)
                          .replace(".", ",")}
                        %
                      </span>
                      <Money
                        value={servicesGross}
                        currency={document.currency}
                        showCurrency={false}
                        className="font-medium text-[var(--color-ink)]"
                      />
                    </li>
                  ) : null}
                </ul>
                <div
                  className={`rounded-[8px] px-3 py-2 text-[12.5px] ${
                    totals.matches
                      ? "border border-[var(--color-accent-soft-border)] bg-[var(--color-accent-soft)] text-[var(--color-accent-strong)]"
                      : "border border-[var(--color-warning-soft-border)] bg-[var(--color-warning-soft)] text-[var(--color-warning-ink)]"
                  }`}
                >
                  {totals.matches ? (
                    "Asignado completo · sin faltante"
                  ) : (
                    <>
                      Falta{" "}
                      <Money value={totals.missing} currency={document.currency} /> por
                      asignar
                    </>
                  )}
                </div>
              </>
            )}
          </Card>
        </div>
      ) : null}

      <div className="flex flex-col gap-2">
        <span className="caps-label text-[var(--color-muted)]">
          Líneas
        </span>
        {document.lines.length === 0 ? (
          <p className="text-[12.5px] text-[var(--color-muted)]">
            No hay líneas registradas para este documento.
          </p>
        ) : (
          <Card padding="0" className="overflow-hidden">
            <ul className="flex flex-col">
              {document.lines.map((line) => (
                <li
                  key={line.id}
                  className="flex items-center justify-between gap-3 border-b border-[var(--color-hairline-soft)] px-4 py-2.5 text-[13px] last:border-b-0"
                >
                  <span className="text-[var(--color-ink-2)]">
                    {line.description ? line.description.replaceAll("--", "—") : "—"}
                  </span>
                  <Money
                    value={line.amount}
                    currency={document.currency}
                    showCurrency={false}
                    className="font-medium text-[var(--color-ink)]"
                  />
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>

      <ReassignPeriodForm
        companyId={id}
        costDocumentId={document.id}
        recognizedPeriod={document.recognized_period}
        recognizedPeriodSetBy={document.recognized_period_set_by}
        recognizedPeriodSetAt={document.recognized_period_set_at}
        currentUserId={user.id}
        currentUserEmail={user.email ?? null}
      />

      <section className="flex flex-col gap-2 rounded-[10px] border border-[var(--color-hairline)] bg-[var(--color-surface)] p-4">
        <h2 className="text-[12.5px] font-semibold uppercase tracking-[0.08em] text-[var(--color-muted)]">Eliminar gasto</h2>
        <p className="text-[12.5px] text-[var(--color-ink-2)]">
          {technicianCharge
            ? "Es el cargo de un técnico (Mano de obra): se corrige o elimina desde la sección Técnicos del trabajo."
            : "Borra el documento con sus líneas, sus asignaciones a trabajos y a servicios y sus comprobantes. Los costos y el margen de los trabajos se recalculan."}
        </p>
        <DeleteCostButton
          variant="button"
          companyId={id}
          costDocumentId={document.id}
          summary={costDeletionSummary({
            description: document.lines.map((line) => line.description).filter(Boolean).join(", "),
            supplierName: document.supplier_name ?? document.project_name,
            date: document.document_date,
          })}
          amount={document.total_amount}
          currency={document.currency}
          note={
            allocations.length > 0
              ? `Está repartido entre ${allocations.length} ${allocations.length === 1 ? "destino" : "destinos"}: se elimina de todos.`
              : null
          }
          technicianChargeHref={technicianCharge ? technicianChargeHref(id, technicianCharge) : null}
          redirectTo={back.href}
        />
      </section>

      <Link
        href={back.href}
        className="text-[13px] text-[var(--color-muted)] hover:text-[var(--color-ink)]"
      >
        {back.label}
      </Link>
    </div>
  );
}
