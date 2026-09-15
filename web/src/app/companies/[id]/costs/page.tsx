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
import { LinkButton } from "@/components/Button";
import { Badge } from "@/components/Badge";
import { Money } from "@/components/Money";
import { Card } from "@/components/Card";
import { TableCard, Th, Td, Tr } from "@/components/Table";
import { EmptyState } from "@/components/EmptyState";

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
};

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
  const needsProjectLookup = Boolean(sp.clientId || sp.businessAreaId);
  const [allProjects, monthDocuments] = await Promise.all([
    needsProjectLookup ? getProjects(id) : Promise.resolve([]),
    getCostDocuments(id, {}),
  ]);

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

  const periodRange = /^\d{4}-\d{2}$/.test(sp.period ?? "")
    ? monthRange(`${sp.period}-01`)
    : null;

  const filters = {
    from: periodRange?.start ?? sp.from,
    to: periodRange?.end ?? sp.to,
    projectId: sp.projectId,
    projectIds,
    classification,
    sortBy,
    sortDirection,
  } as const;
  const hasActiveFilters = Boolean(
    filters.from ||
      filters.to ||
      filters.projectId ||
      (filters.projectIds && filters.projectIds.length > 0) ||
      filters.classification,
  );
  const isRollup = Boolean(sp.clientId || sp.businessAreaId);

  // The summary cards always need the unfiltered list (fetched above,
  // alongside allProjects); only fetch a second, filtered/sorted list
  // when a filter is active or a non-default sort was requested -- the
  // common case (no filter, default sort) reuses monthDocuments, which
  // is already in that same order, avoiding a redundant round-trip.
  const allDocuments = hasActiveFilters || !isDefaultSort
    ? await getCostDocuments(id, filters)
    : monthDocuments;

  const showUnassignedOnly = sp.unassigned === "1";
  const documents = showUnassignedOnly
    ? allDocuments.filter(
        (document) => document.classification === "general" && !document.is_allocated,
      )
    : allDocuments;

  const unassignedCount = monthDocuments.filter(
    (document) => document.classification === "general" && !document.is_allocated,
  ).length;
  const totalAmount = monthDocuments.reduce(
    (sum, d) => sum + Number(d.net_amount ?? 0),
    0,
  );
  const directAmount = monthDocuments
    .filter((d) => d.classification === "direct")
    .reduce((sum, d) => sum + Number(d.net_amount ?? 0), 0);
  const generalAmount = monthDocuments
    .filter((d) => d.classification === "general")
    .reduce((sum, d) => sum + Number(d.net_amount ?? 0), 0);

  const filteredProjectName = sp.projectId
    ? allProjects.find((project) => project.id === sp.projectId)?.name
    : undefined;

  const filteredTotal = documents.reduce(
    (sum, document) => sum + Number(document.net_amount ?? 0),
    0,
  );

  const currency = membership.company.currency;

  function chipHrefWithout(key: keyof CostsPageSearchParams) {
    const next = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) {
      if (v && k !== key) next.set(k, v);
    }
    const qs = next.toString();
    return `/companies/${id}/costs${qs ? `?${qs}` : ""}`;
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
    <div className="flex flex-col gap-[18px]">
      <PageHeader
        eyebrow="GESTIÓN / COSTOS"
        title="Costos"
        subtitle={membership.company.name}
        actions={
          <LinkButton href={`/companies/${id}/costs/new`} variant="primary">
            Nuevo documento
          </LinkButton>
        }
      />

      <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-3">
        <Card className="flex items-center justify-between">
          <div className="flex flex-col gap-1">
            <span className="font-mono text-[10px] uppercase tracking-[0.13em] text-[var(--color-muted)]">
              Total del mes
            </span>
            <Money value={totalAmount} currency={currency} className="text-[20px] font-semibold text-[var(--color-ink)]" />
          </div>
        </Card>
        <Card className="flex items-center justify-between">
          <div className="flex flex-col gap-1">
            <span className="font-mono text-[10px] uppercase tracking-[0.13em] text-[var(--color-muted)]">
              Directos
            </span>
            <Money value={directAmount} currency={currency} className="text-[20px] font-semibold text-[var(--color-ink)]" />
          </div>
        </Card>
        <Card className="flex items-center justify-between">
          <div className="flex flex-col gap-1">
            <span className="font-mono text-[10px] uppercase tracking-[0.13em] text-[var(--color-muted)]">
              Generales
            </span>
            <Money value={generalAmount} currency={currency} className="text-[20px] font-semibold text-[var(--color-ink)]" />
          </div>
          {unassignedCount > 0 ? (
            <span className="max-w-[130px] text-right text-[12px] text-[var(--color-negative-ink)]">
              {unassignedCount} sin asignar
            </span>
          ) : null}
        </Card>
      </div>

      <div className="flex flex-wrap gap-1.5">
        <Link
          href={`/companies/${id}/costs`}
          className={`rounded-lg px-3 py-1.5 text-[13px] font-medium no-underline ${
            !classification && !showUnassignedOnly
              ? "bg-[var(--color-ink)] text-[#f2f2ef]"
              : "border border-[var(--color-hairline)] bg-white text-[var(--color-ink-2)]"
          }`}
        >
          Todos
        </Link>
        <Link
          href={`/companies/${id}/costs?classification=direct`}
          className={`rounded-lg px-3 py-1.5 text-[13px] font-medium no-underline ${
            classification === "direct"
              ? "bg-[var(--color-ink)] text-[#f2f2ef]"
              : "border border-[var(--color-hairline)] bg-white text-[var(--color-ink-2)]"
          }`}
        >
          Directos
        </Link>
        <Link
          href={`/companies/${id}/costs?classification=general`}
          className={`rounded-lg px-3 py-1.5 text-[13px] font-medium no-underline ${
            classification === "general" && !showUnassignedOnly
              ? "bg-[var(--color-ink)] text-[#f2f2ef]"
              : "border border-[var(--color-hairline)] bg-white text-[var(--color-ink-2)]"
          }`}
        >
          Generales
        </Link>
        <Link
          href={`/companies/${id}/costs?classification=general&unassigned=1`}
          className={`rounded-lg px-3 py-1.5 text-[13px] font-medium no-underline ${
            showUnassignedOnly
              ? "bg-[var(--color-ink)] text-[#f2f2ef]"
              : "border border-[var(--color-hairline)] bg-white text-[var(--color-ink-2)]"
          }`}
        >
          Sin asignar
          {unassignedCount > 0 ? (
            <span className="ml-1.5 font-mono text-[11px] text-[var(--color-negative-ink)]">
              {unassignedCount}
            </span>
          ) : null}
        </Link>
      </div>

      <form
        method="get"
        className="flex flex-wrap items-center gap-2.5 rounded-[9px] border border-[var(--color-hairline)] bg-white p-2.5"
      >
        {sp.classification ? (
          <input type="hidden" name="classification" value={sp.classification} />
        ) : null}
        {sp.unassigned ? <input type="hidden" name="unassigned" value={sp.unassigned} /> : null}
        <input
          type="month"
          name="period"
          defaultValue={sp.period ?? ""}
          aria-label="Mes y año"
          className="rounded-lg border border-[var(--color-hairline)] px-3 py-[7px] text-[13px] text-[var(--color-ink)]"
        />
        <button
          type="submit"
          className="rounded-lg border border-[var(--color-hairline)] bg-white px-3.5 py-2 text-[13px] font-medium text-[var(--color-ink)]"
        >
          Filtrar
        </button>
      </form>

      {hasActiveFilters ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-[9px] border border-[var(--color-accent-soft-border)] bg-[var(--color-accent-soft)] px-4 py-[11px]">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-[var(--color-accent-strong)]">
            {sp.period ? (
              <Link href={chipHrefWithout("period")} className="text-[var(--color-accent-strong)] no-underline">
                {sp.period} ✕
              </Link>
            ) : filters.from || filters.to ? (
              <span>{filters.from ?? "…"} → {filters.to ?? "…"}</span>
            ) : null}
            {filteredProjectName ? <span>· Proyecto: {filteredProjectName}</span> : null}
          </div>
          <Link
            href={`/companies/${id}/costs`}
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
                <EmptyState message="No hay documentos de costo en este período." />
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
                <Td className="font-mono text-[12.5px] text-[var(--color-ink-2)]">
                  {document.document_date}
                </Td>
                <Td className="font-medium text-[var(--color-ink)]">
                  {document.supplier_name ?? "—"}
                </Td>
                <Td>
                  <Badge variant={document.classification === "direct" ? "positive" : "neutral"}>
                    {CLASSIFICATION_LABEL[document.classification] ?? document.classification}
                  </Badge>
                </Td>
                <Td className="text-[var(--color-ink-2)]">
                  {document.classification === "direct"
                    ? (document.project_name ?? "—")
                    : document.is_allocated
                      ? "Prorrateo por ingresos"
                      : "Sin asignar"}
                </Td>
                <Td align="right" className="font-semibold text-[var(--color-ink)]">
                  <Money value={document.total_amount} currency={document.currency} showCurrency={false} />
                </Td>
                <Td align="right">
                  <div className="flex justify-end gap-3">
                    <Link
                      href={`/companies/${id}/costs/${document.id}`}
                      className="text-[12.5px] font-medium text-[var(--color-accent-strong)]"
                    >
                      Ver
                    </Link>
                    {document.classification === "general" ? (
                      <Link
                        href={`/companies/${id}/costs/${document.id}/allocate`}
                        className="text-[12.5px] font-medium text-[var(--color-accent-strong)]"
                      >
                        {document.is_allocated ? "Editar asignación" : "Asignar"}
                      </Link>
                    ) : null}
                  </div>
                </Td>
              </Tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="bg-[var(--color-surface-muted)]">
              <td colSpan={4} className="px-3 py-2.5 text-[12.5px] text-[var(--color-muted)]">
                Mostrando {documents.length} documentos
              </td>
              <td colSpan={2} className="px-3 py-2.5 text-right font-mono text-[13px] font-semibold text-[var(--color-ink)]">
                <Money value={filteredTotal} currency={currency} />
              </td>
            </tr>
          </tfoot>
        </TableCard>
      )}
    </div>
  );
}
