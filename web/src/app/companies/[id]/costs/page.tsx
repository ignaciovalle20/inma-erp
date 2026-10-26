import Link from "next/link";
import { redirect } from "next/navigation";
import {
  getSession,
  getCompanyForEdit,
  getCostDocuments,
  getProjects,
  type CostClassification,
} from "@/lib/dal";
import { monthRange } from "@/lib/reporting";
import { PageHeader } from "@/components/PageHeader";
import { Button, LinkButton } from "@/components/Button";
import { suggestCostServiceAllocations } from "./suggest-actions";
import { Badge } from "@/components/Badge";
import { Money } from "@/components/Money";
import { summarizeCostDocuments } from "@/lib/costTotals";
import { getRateTable } from "@/lib/exchangeRates";
import { MoneyBreakdown } from "@/components/MoneyBreakdown";
import { Card } from "@/components/Card";
import { TableCard, Th, Td, Tr } from "@/components/Table";
import { EmptyState } from "@/components/EmptyState";
import { monthLabel, resolvePeriod, shiftMonth } from "@/lib/period";
import { formatDisplayDate } from "@/lib/paymentStatus";
import { getLinkedDocumentIds, getTechnicianChargeCostLinks } from "@/lib/technicianDal";
import { costDeletionSummary, technicianChargeHrefs } from "@/lib/costDocumentDeletion";
import { DeleteCostButton } from "./delete-cost-button";

const CLASSIFICATION_LABEL: Record<string, string> = {
  direct: "Directo",
  general: "General",
};

type CostsPageSearchParams = {
  from?: string;
  to?: string;
  projectId?: string;
  classification?: string;
  unassigned?: string;
  // Client/area profitability drill-downs roll up several projects at
  // once -- resolved below into a projectIds filter, since cost_documents
  // has no client_id/business_area_id column of its own.
  clientId?: string;
  businessAreaId?: string;
  sort?: string;
  order?: string;
  // "YYYY-MM", from the visible month/year filter control -- resolved
  // below into from/to, same [start, end) convention the from/to
  // drill-down links already use.
  period?: string;
  // What "Sugerir asignaciones" did (suggest-actions.ts).
  confirmadas?: string;
  sugeridas?: string;
  sugerencias?: string;
};

/** A failed read comes back as a message to show, not as an empty list that reads as "no costs". */
async function loadCostDocuments(
  companyId: string,
  filters: Parameters<typeof getCostDocuments>[1],
): Promise<{ documents: Awaited<ReturnType<typeof getCostDocuments>>; error: string | null }> {
  try {
    return { documents: await getCostDocuments(companyId, filters), error: null };
  } catch (thrown) {
    console.error(thrown);
    return {
      documents: [],
      error: thrown instanceof Error ? thrown.message : "No se pudieron leer los costos.",
    };
  }
}

export default async function CostDocumentsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<CostsPageSearchParams>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const user = await getSession();

  if (!user) {
    redirect("/login");
  }

  // Any membership (any role) is enough to view a company's cost
  // documents -- getCompanyForEdit doubles as the membership check here.
  const membership = await getCompanyForEdit(id);

  if (!membership) {
    redirect("/companies");
  }

  // Story 6.4: drill-down filters, plain GET query params -- no new
  // state/session mechanism, per spec Boundaries.
  const classification =
    sp.classification === "direct" || sp.classification === "general"
      ? (sp.classification as CostClassification)
      : undefined;

  // Only the client/area rollup below actually needs the project list --
  // a plain projectId filter uses sp.projectId directly. Fetched
  // alongside monthDocuments (neither depends on the other) instead of
  // blocking it.
  // The month on screen (null = the whole history). The cards and the list
  // follow it: they used to add up every cost of the company whatever the month
  // (docs/plan-sistema-v3.md, H10).
  const period = resolvePeriod(sp);
  const periodRange = period ? monthRange(`${period}-01`) : null;
  const periodFilters = { from: periodRange?.start ?? sp.from, to: periodRange?.end ?? sp.to } as const;

  const needsProjectLookup = Boolean(sp.clientId || sp.businessAreaId);
  const [allProjects, monthResult, rates, technicianLinks, linkedToCharges] = await Promise.all([
    needsProjectLookup ? getProjects(id) : Promise.resolve([]),
    loadCostDocuments(id, periodFilters),
    getRateTable(),
    // Unread, "Eliminar" still finds out on submit (the action checks again).
    getTechnicianChargeCostLinks(id).catch((thrown) => {
      console.error(thrown);
      return [];
    }),
    // Unread, the assignment screens still say it (and the database refuses).
    getLinkedDocumentIds(id).catch((thrown) => {
      console.error(thrown);
      return new Set<string>();
    }),
  ]);
  const chargeHrefByCost = technicianChargeHrefs(id, technicianLinks);
  const monthDocuments = monthResult.documents;
  let loadError = monthResult.error;

  // A client/area's cost figure rolls up every project tagged to it
  // (see computeClientProfitability/computeAreaProfitability) --
  // resolved here into a project id list, since cost_documents has no
  // client_id/business_area_id of its own to filter on directly. This
  // only covers each project's own direct costs, not cost_allocations
  // shares targeting the client/area directly (those aren't separately
  // listable rows -- noted inline below, same caveat the spec accepts
  // for project drill-downs).
  const projectIds = sp.clientId
    ? allProjects
        .filter((project) => project.client_id === sp.clientId)
        .map((project) => project.id)
    : sp.businessAreaId
      ? allProjects
          .filter((project) => project.business_area_id === sp.businessAreaId)
          .map((project) => project.id)
      : undefined;

  const sortBy = sp.sort === "total" ? "total" : "date";
  const sortDirection = sp.order === "asc" ? "asc" : "desc";
  const isDefaultSort = sortBy === "date" && sortDirection === "desc";

  const filters = {
    ...periodFilters,
    projectId: sp.projectId,
    projectIds,
    classification,
    sortBy,
    sortDirection,
  } as const;
  // Filters other than the month (the month has its own navigator).
  const hasOtherFilters = Boolean(
    filters.projectId ||
      (filters.projectIds && filters.projectIds.length > 0) ||
      filters.classification,
  );
  const isRollup = Boolean(sp.clientId || sp.businessAreaId);

  // The summary cards need the whole month (fetched above, alongside
  // allProjects); only fetch a second, filtered/sorted list when a filter
  // other than the month is active or a non-default sort was requested -- the
  // common case reuses monthDocuments, which is already in that same order,
  // avoiding a redundant round-trip.
  let allDocuments = monthDocuments;
  if (!loadError && (hasOtherFilters || !isDefaultSort)) {
    const listResult = await loadCostDocuments(id, filters);
    allDocuments = listResult.documents;
    loadError = listResult.error;
  }

  const showUnassignedOnly = sp.unassigned === "1";
  const documents = showUnassignedOnly
    ? allDocuments.filter(
        (document) => document.classification === "general" && !document.is_allocated,
      )
    : allDocuments;

  const unassignedCount = monthDocuments.filter(
    (document) => document.classification === "general" && !document.is_allocated,
  ).length;
  // Each currency apart, plus the combined total in local currency and USD.
  const monthTotals = summarizeCostDocuments(monthDocuments, membership.company.currency, rates);

  const filteredProjectName = sp.projectId
    ? allProjects.find((project) => project.id === sp.projectId)?.name
    : undefined;

  const filteredTotals = summarizeCostDocuments(documents, membership.company.currency, rates);

  const currency = membership.company.currency;

  // A link on this screen keeps the month on screen (period=all for the whole
  // history), so it never falls back to the default month by accident.
  function costsHref(query: string, month: string | null = period) {
    return `/companies/${id}/costs?period=${month ?? "all"}${query ? `&${query}` : ""}`;
  }

  // Clicking the currently-active sort column flips its direction;
  // clicking the other one switches to it at that column's natural
  // default (most recent / highest first).
  function sortHref(column: "date" | "total") {
    const next = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) {
      if (v && k !== "sort" && k !== "order") next.set(k, v);
    }
    const nextDirection = sortBy === column && sortDirection === "desc" ? "asc" : "desc";
    next.set("sort", column);
    next.set("order", nextDirection);
    return `/companies/${id}/costs?${next.toString()}`;
  }

  function sortIndicator(column: "date" | "total") {
    if (sortBy !== column) return null;
    return <span className="ml-1 text-[var(--color-faint)]">{sortDirection === "asc" ? "↑" : "↓"}</span>;
  }

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <PageHeader
        eyebrow="GESTIÓN / COSTOS"
        title="Costos"
        subtitle={membership.company.name}
        actions={
          <>
            <form action={suggestCostServiceAllocations.bind(null, id, period)}>
              <Button
                type="submit"
                variant="secondary"
                title="Asigna las facturas de compra a los períodos de costo de los servicios recurrentes de su proveedor"
              >
                Sugerir asignaciones
              </Button>
            </form>
            <LinkButton href={`/companies/${id}/costs/import`} variant="secondary">
              Importar
            </LinkButton>
            <LinkButton href={`/companies/${id}/costs/ms-licenses`} variant="secondary">
              Reparto licencias MS
            </LinkButton>
            <LinkButton href={`/companies/${id}/costs/new`} variant="primary">
              Nuevo documento
            </LinkButton>
          </>
        }
      />

      {sp.confirmadas !== undefined ? (
        <p role="status" className="rounded-lg bg-[var(--color-accent-soft)] px-3 py-2 text-[12.5px] text-[var(--color-accent-strong)]">
          {Number(sp.confirmadas) + Number(sp.sugeridas ?? 0) === 0
            ? "No hubo facturas nuevas para asignar a servicios recurrentes."
            : `${Number(sp.confirmadas) || 0} factura(s) asignadas y confirmadas a servicios; ${Number(sp.sugeridas) || 0} sugerida(s) para confirmar en Conciliar.`}
        </p>
      ) : null}
      {sp.sugerencias === "error" ? (
        <p role="alert" className="text-[12.5px] text-[var(--color-negative-ink)]">
          No se pudieron calcular las sugerencias. Intentá de nuevo.
        </p>
      ) : null}

      {loadError ? (
        <div
          role="alert"
          className="rounded-lg border border-[var(--color-negative-soft)] bg-[var(--color-negative-soft)] px-3 py-2.5 text-[13px] text-[var(--color-negative-ink)]"
        >
          {loadError}
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {[
          { label: period ? `Total de ${monthLabel(period)}` : "Total del historial", summary: monthTotals.total, note: null },
          { label: "Directos", summary: monthTotals.direct, note: null },
          {
            label: "Generales",
            summary: monthTotals.general,
            note: unassignedCount > 0 ? `${unassignedCount} sin asignar` : null,
          },
        ].map((card) => (
          <Card key={card.label} className="flex min-w-0 flex-col gap-2">
            <div className="flex items-start justify-between gap-2">
              <span className="caps-label text-[var(--color-muted)]">{card.label} · neto sin IVA</span>
              {card.note ? (
                <span className="text-right text-[12px] text-[var(--color-negative-ink)]">{card.note}</span>
              ) : null}
            </div>
            {card.summary.byCurrency.length === 0 ? (
              <Money value={0} currency={currency} className="text-[20px] font-semibold text-[var(--color-ink)]" />
            ) : (
              card.summary.byCurrency.map((subtotal) => (
                <div key={subtotal.currency} className="flex items-baseline justify-between gap-2">
                  <span className="text-[12px] text-[var(--color-muted)]">Gastado {subtotal.currency}</span>
                  <Money
                    value={subtotal.amount}
                    currency={subtotal.currency}
                    className="text-[18px] font-semibold text-[var(--color-ink)]"
                  />
                </div>
              ))
            )}
            <MoneyBreakdown
              summary={card.summary}
              label="Total combinado"
              showSubtotals={false}
              className="border-t border-[var(--color-hairline-soft)] pt-1.5"
            />
          </Card>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {period ? (
          <>
            <Link
              href={costsHref("", shiftMonth(period, -1))}
              className="rounded-md border border-[var(--color-accent-soft-border)] bg-[var(--color-surface)] px-2 py-0.5 text-[12px] text-[var(--color-accent-strong)] no-underline"
              aria-label="Mes anterior"
            >
              ◀
            </Link>
            <span className="min-w-[130px] text-center text-[13.5px] font-semibold capitalize text-[var(--color-ink)]">
              {monthLabel(period)}
            </span>
            <Link
              href={costsHref("", shiftMonth(period, 1))}
              className="rounded-md border border-[var(--color-accent-soft-border)] bg-[var(--color-surface)] px-2 py-0.5 text-[12px] text-[var(--color-accent-strong)] no-underline"
              aria-label="Mes siguiente"
            >
              ▶
            </Link>
            <Link href={costsHref("", null)} className="text-[12.5px] text-[var(--color-accent-strong)]">
              Ver todo el historial
            </Link>
          </>
        ) : (
          <span className="text-[13.5px] font-semibold text-[var(--color-ink)]">
            {filters.from || filters.to ? `${filters.from ?? "…"} → ${filters.to ?? "…"}` : "Todo el historial"}
          </span>
        )}
      </div>

      <div className="surface-card flex flex-wrap items-center gap-3 p-3">
        <form method="get" className="flex flex-wrap items-center gap-2">
          {sp.classification ? (
            <input type="hidden" name="classification" value={sp.classification} />
          ) : null}
          {sp.unassigned ? <input type="hidden" name="unassigned" value={sp.unassigned} /> : null}
          <input
            type="month"
            name="period"
            defaultValue={period ?? ""}
            aria-label="Mes y año"
            className="control"
          />
          <button
            type="submit"
            className="inline-flex min-h-9 items-center rounded-control border border-[var(--color-hairline)] bg-[var(--color-surface)] px-3.5 text-body font-medium text-[var(--color-ink)] hover:border-[var(--color-border-hover)]"
          >
            Filtrar
          </button>
        </form>

        <div className="flex flex-wrap gap-1.5">
          <Link
            href={costsHref("")}
            className={`tab-chip ${!classification && !showUnassignedOnly ? "tab-chip-active" : ""}`}
          >
            Todos
          </Link>
          <Link
            href={costsHref("classification=direct")}
            className={`tab-chip ${classification === "direct" ? "tab-chip-active" : ""}`}
          >
            Directos
          </Link>
          <Link
            href={costsHref("classification=general")}
            className={`tab-chip ${classification === "general" && !showUnassignedOnly ? "tab-chip-active" : ""}`}
          >
            Generales
          </Link>
          <Link
            href={costsHref("classification=general&unassigned=1")}
            className={`tab-chip ${showUnassignedOnly ? "tab-chip-active" : ""}`}
          >
            Sin asignar
            {unassignedCount > 0 ? (
              <span className="ml-1.5 font-mono text-[11px] text-[var(--color-negative-ink)]">
                {unassignedCount}
              </span>
            ) : null}
          </Link>
        </div>
      </div>

      {hasOtherFilters ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-[9px] border border-[var(--color-accent-soft-border)] bg-[var(--color-accent-soft)] px-4 py-[11px]">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-[var(--color-accent-strong)]">
            {filteredProjectName ? <span>· Proyecto: {filteredProjectName}</span> : null}
          </div>
          <Link
            href={costsHref("")}
            className="text-[12.5px] font-medium text-[var(--color-accent-strong)]"
          >
            Limpiar
          </Link>
        </div>
      ) : null}

      {isRollup ? (
        <p className="text-[12px] text-[var(--color-muted)]">
          Esta lista muestra los costos directos propios de cada proyecto.
          Los costos generales prorrateados a este cliente o área están
          incluidos en la cifra del reporte pero no aparecen como filas acá.
        </p>
      ) : null}

      {documents.length === 0 ? (
        <TableCard>
          <tbody>
            <tr>
              <td>
                <EmptyState
                  message={
                    loadError
                      ? "No se pudo cargar el listado (ver el error de arriba)."
                      : "No hay documentos de costo en este período."
                  }
                />
              </td>
            </tr>
          </tbody>
        </TableCard>
      ) : (
        <TableCard>
          <thead>
            <tr>
              <Th>
                <Link href={sortHref("date")} className="text-inherit no-underline hover:text-[var(--color-ink)]">
                  Fecha{sortIndicator("date")}
                </Link>
              </Th>
              <Th>Proveedor</Th>
              <Th>Clasificación</Th>
              <Th>Imputado a</Th>
              <Th align="right">
                <Link href={sortHref("total")} className="text-inherit no-underline hover:text-[var(--color-ink)]">
                  Total{sortIndicator("total")}
                </Link>
              </Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {documents.map((document) => (
              <Tr key={document.id}>
                <Td className="whitespace-nowrap font-mono text-[12.5px] text-[var(--color-ink-2)]">
                  {formatDisplayDate(document.document_date)}
                </Td>
                <Td className="font-medium text-[var(--color-ink)]">
                  {document.supplier_name ?? "—"}
                </Td>
                <Td>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge variant={document.classification === "direct" ? "positive" : "neutral"}>
                      {CLASSIFICATION_LABEL[document.classification] ?? document.classification}
                    </Badge>
                    {document.covered_by_cost_pool_id ? (
                      <Link
                        href={`/companies/${id}/costs/ms-licenses/${document.covered_by_cost_pool_id}`}
                        title="La factura de licencias MS de este mes ya está en su reparto: este documento no suma a los reportes."
                        className="inline-flex no-underline"
                      >
                        <Badge variant="warning">Cubierto por pool</Badge>
                      </Link>
                    ) : null}
                  </div>
                </Td>
                <Td className="text-[var(--color-ink-2)]">
                  {document.classification === "direct"
                    ? (document.project_name ?? "—")
                    : (document.service_allocated_amount ?? 0) > 0
                      ? document.is_split
                        ? "Servicios y prorrateo"
                        : "Servicios recurrentes"
                      : document.is_allocated
                        ? "Prorrateo por ingresos"
                        : "Sin asignar"}
                </Td>
                <Td align="right" className="font-semibold text-[var(--color-ink)]">
                  <Money value={document.total_amount} currency={document.currency} showCurrency={document.currency !== currency} />
                </Td>
                <Td align="right">
                  <div className="flex justify-end gap-3 whitespace-nowrap">
                    <Link
                      href={`/companies/${id}/costs/${document.id}`}
                      className="text-[12.5px] font-medium text-[var(--color-accent-strong)]"
                    >
                      Ver
                    </Link>
                    {linkedToCharges.has(document.id) ? (
                      <Link
                        href={`/companies/${id}/costs/${document.id}/technician`}
                        title="Vinculada a cargos de técnico — desvinculá para cambiar"
                        className="text-[12.5px] font-medium text-[var(--color-muted)]"
                      >
                        Vinculada a técnico
                      </Link>
                    ) : null}
                    {document.classification === "general" && !document.is_allocated && !linkedToCharges.has(document.id) ? (
                      <Link
                        href={`/companies/${id}/costs/${document.id}/assign`}
                        className="text-[12.5px] font-medium text-[var(--color-accent-strong)]"
                      >
                        Asignar a un trabajo
                      </Link>
                    ) : null}
                    {document.classification === "general" &&
                    document.supplier_id &&
                    !document.covered_by_cost_pool_id &&
                    !document.is_split &&
                    !linkedToCharges.has(document.id) ? (
                      <Link
                        href={`/companies/${id}/costs/${document.id}/services`}
                        className="text-[12.5px] font-medium text-[var(--color-accent-strong)]"
                      >
                        {document.is_allocated ? "Editar servicios" : "Asignar a servicios"}
                      </Link>
                    ) : null}
                    {/* A split, with or without services, is edited here; a services-only invoice can be split too. */}
                    {document.classification === "general" && !linkedToCharges.has(document.id) ? (
                      <Link
                        href={`/companies/${id}/costs/${document.id}/allocate`}
                        className="text-[12.5px] font-medium text-[var(--color-accent-strong)]"
                      >
                        {document.is_split ? "Editar asignación" : "Dividir"}
                      </Link>
                    ) : null}
                    <DeleteCostButton
                      companyId={id}
                      costDocumentId={document.id}
                      summary={costDeletionSummary({
                        description: document.project_name,
                        supplierName: document.supplier_name,
                        date: formatDisplayDate(document.document_date),
                      })}
                      amount={document.total_amount}
                      currency={document.currency}
                      technicianChargeHref={chargeHrefByCost.get(document.id) ?? null}
                    />
                  </div>
                </Td>
              </Tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="bg-[var(--color-surface-muted)]">
              <td colSpan={4} className="px-3 py-2.5 text-[12.5px] text-[var(--color-muted)]">
                Mostrando {documents.length} documentos
                {filteredTotals.coveredByPool.count > 0 ? (
                  <span className="block">
                    {filteredTotals.coveredByPool.count} cubierto(s) por el reparto de licencias MS de su mes: no se suman al total (el reparto ya tiene ese costo)
                  </span>
                ) : null}
              </td>
              <td colSpan={2} className="px-3 py-2.5 text-right text-[12.5px] font-semibold text-[var(--color-ink)]">
                <MoneyBreakdown summary={filteredTotals.total} label="Total neto" subtotalLabel="Neto" />
              </td>
            </tr>
          </tfoot>
        </TableCard>
      )}
    </div>
  );
}
