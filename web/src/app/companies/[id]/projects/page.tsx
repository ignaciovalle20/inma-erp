import Link from "next/link";
import { redirect } from "next/navigation";
import {
  getSession,
  getCompanyForEdit,
  listProjects,
  getProjectClosedYears,
  withProjectCostStatus,
  type ProjectCostStatus,
  type ProjectListRow,
  type ProjectListScope,
} from "@/lib/dal";
import { confirmProjectCostZero, removeProjectCostConfirmation } from "./actions";
import { ProjectSearch } from "./search";
import { ProjectYearFilter } from "./year-filter";
import { PageHeader } from "@/components/PageHeader";
import { PeriodPicker } from "@/components/PeriodPicker";
import { LinkButton } from "@/components/Button";
import { Badge, type BadgeVariant } from "@/components/Badge";
import { Money } from "@/components/Money";
import { TableCard, Th, Td, Tr } from "@/components/Table";
import { EmptyState } from "@/components/EmptyState";
import { SubmitTextButton } from "@/components/SubmitTextButton";
import { PROJECT_STATUS_LABEL, PROJECT_STATUS_BADGE_VARIANT } from "@/lib/projectStatus";
import { MONTH_PATTERN, currentMonth } from "@/lib/period";
import { formatDisplayDate } from "@/lib/paymentStatus";
import { todayForCountry } from "@/lib/recurringServicePending";

const COST_STATUS_LABEL: Record<ProjectCostStatus, string> = {
  has_costs: "Con costos",
  confirmed_zero: "Cero confirmado",
  pending: "Pendiente",
};

const COST_STATUS_VARIANT: Record<ProjectCostStatus, BadgeVariant> = {
  has_costs: "outline",
  confirmed_zero: "positive",
  pending: "warning",
};

/** Finalizados, Todos and search results are read 25 at a time. */
const PAGE_SIZE = 25;

const TABS: { scope: ProjectListScope; label: string }[] = [
  { scope: "activos", label: "Activos" },
  { scope: "finalizados", label: "Finalizados" },
  { scope: "todos", label: "Todos" },
];

type ProjectsSearchParams = {
  period?: string;
  q?: string;
  estado?: string;
  anio?: string;
  page?: string;
};

export default async function ProjectsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<ProjectsSearchParams>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const user = await getSession();

  if (!user) {
    redirect("/login");
  }

  // Any membership (any role) is enough to view a company's projects --
  // getCompanyForEdit doubles as the membership check here.
  const membership = await getCompanyForEdit(id);

  if (!membership) {
    redirect("/companies");
  }

  const basePath = `/companies/${id}/projects`;
  const country = membership.company.country;
  const period = MONTH_PATTERN.test(sp.period ?? "")
    ? (sp.period as string)
    : currentMonth(country);
  const periodDate = `${period}-01`;

  const scope: ProjectListScope =
    sp.estado === "finalizados" || sp.estado === "todos" ? sp.estado : "activos";
  const query = (sp.q ?? "").trim();
  // A search covers every status, whatever tab was open.
  const searching = query.length > 0;
  const year = scope === "finalizados" && /^\d{4}$/.test(sp.anio ?? "") ? Number(sp.anio) : null;
  // Activos keeps showing the whole working set on one page, as before.
  const paged = searching || scope !== "activos";
  const currentPage = paged ? Math.max(1, Number.parseInt(sp.page ?? "1", 10) || 1) : 1;
  const showCostStatus = !searching && scope === "activos";

  // Querystring of the current view, for the search box and page links.
  const viewParams: Record<string, string> = {};
  if (scope !== "activos") viewParams.estado = scope;
  if (year != null) viewParams.anio = String(year);
  if (sp.period && MONTH_PATTERN.test(sp.period)) viewParams.period = sp.period;

  function pageHref(page: number): string {
    const next = new URLSearchParams(viewParams);
    if (query) next.set("q", query);
    if (page > 1) next.set("page", String(page));
    const qs = next.toString();
    return qs ? `${basePath}?${qs}` : basePath;
  }

  let projects: ProjectListRow[] = [];
  let total = 0;
  let years: number[] = [];
  const costStatusById = new Map<string, ProjectCostStatus>();
  let loadError: string | null = null;

  try {
    const [list, closedYears] = await Promise.all([
      listProjects(id, {
        scope,
        query,
        year,
        limit: paged ? PAGE_SIZE : undefined,
        offset: paged ? (currentPage - 1) * PAGE_SIZE : 0,
      }),
      scope === "finalizados" && !searching ? getProjectClosedYears(id) : Promise.resolve([]),
    ]);
    projects = list.rows;
    total = list.total;
    years = closedYears;

    // The month's cost completeness only applies to jobs in execution
    // (getProjectCostStatus's scope, which the dashboard also uses).
    if (showCostStatus) {
      const withStatus = await withProjectCostStatus(
        projects.filter((project) => project.status === "en_ejecucion"),
        periodDate,
      );
      for (const project of withStatus) costStatusById.set(project.id, project.cost_status);
    }
  } catch (thrown) {
    console.error(thrown);
    loadError = thrown instanceof Error ? thrown.message : "No se pudo leer el estado de los proyectos.";
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (paged && !loadError && projects.length === 0 && total > 0 && currentPage > totalPages) {
    redirect(pageHref(totalPages));
  }

  const emptyMessage = searching
    ? `No hay proyectos que coincidan con “${query}”.`
    : scope === "finalizados"
      ? year != null
        ? `No hay proyectos finalizados en ${year}.`
        : "No hay proyectos finalizados para esta empresa."
      : scope === "todos"
        ? "No hay proyectos para esta empresa."
        : "No hay proyectos activos para esta empresa.";

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <PageHeader
        eyebrow="GESTIÓN / PROYECTOS"
        title="Proyectos"
        subtitle={membership.company.name}
        actions={
          <>
            {showCostStatus ? <PeriodPicker period={period} basePath={basePath} /> : null}
            <LinkButton href={`${basePath}/board`} variant="secondary">
              Tablero
            </LinkButton>
            <LinkButton href={`${basePath}/new`} variant="primary">
              Nuevo trabajo
            </LinkButton>
          </>
        }
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1.5">
          {TABS.map((tab) => {
            const selected = !searching && tab.scope === scope;
            return (
              <Link
                key={tab.scope}
                href={tab.scope === "activos" ? basePath : `${basePath}?estado=${tab.scope}`}
                aria-current={selected ? "page" : undefined}
                className={`tab-chip ${selected ? "tab-chip-active" : ""}`}
              >
                {tab.label}
              </Link>
            );
          })}
          {scope === "finalizados" && !searching && years.length > 0 ? (
            <ProjectYearFilter basePath={basePath} years={years} year={year} />
          ) : null}
        </div>
        <ProjectSearch basePath={basePath} query={query} keep={viewParams} />
      </div>

      {searching && !loadError ? (
        <p className="text-[12.5px] text-[var(--color-muted)]">
          {total} resultado{total === 1 ? "" : "s"} en todos los estados.
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

      {loadError ? null : projects.length === 0 ? (
        <TableCard>
          <tbody>
            <tr>
              <td>
                <EmptyState message={emptyMessage} />
              </td>
            </tr>
          </tbody>
        </TableCard>
      ) : (
        <TableCard>
          <thead>
            <tr>
              <Th>Proyecto</Th>
              <Th>Estado</Th>
              {showCostStatus ? <Th>Costo del mes</Th> : <Th>Finalizado</Th>}
              <Th align="right">Cotización</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {projects.map((project) => {
              const costStatus = costStatusById.get(project.id);
              return (
                <Tr key={project.id}>
                  <Td className="font-medium text-[var(--color-ink)]">
                    <Link href={`${basePath}/${project.id}`}>{project.name}</Link>
                    <span className="block text-[11px] font-normal text-[var(--color-faint)]">
                      {[project.client_name, project.business_area_name]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </Td>
                  <Td>
                    <Badge variant={PROJECT_STATUS_BADGE_VARIANT[project.status] ?? "neutral"}>
                      {PROJECT_STATUS_LABEL[project.status] ?? project.status}
                    </Badge>
                  </Td>
                  {showCostStatus ? (
                    <Td>
                      {costStatus ? (
                        <Badge variant={COST_STATUS_VARIANT[costStatus]}>
                          {COST_STATUS_LABEL[costStatus]}
                        </Badge>
                      ) : (
                        "—"
                      )}
                    </Td>
                  ) : (
                    <Td className="font-mono">
                      {project.closed_at
                        ? formatDisplayDate(todayForCountry(country, new Date(project.closed_at)))
                        : "—"}
                    </Td>
                  )}
                  <Td align="right">
                    {project.quoted_amount != null ? (
                      <Money value={project.quoted_amount} currency={membership.company.currency} showCurrency={false} />
                    ) : (
                      "—"
                    )}
                  </Td>
                  <Td align="right">
                    <div className="flex items-center justify-end gap-3">
                      {costStatus === "pending" ? (
                        <form
                          action={confirmProjectCostZero.bind(
                            null,
                            id,
                            project.id,
                            periodDate,
                          )}
                        >
                          <SubmitTextButton
                            pendingLabel="Confirmando…"
                            className="text-[12.5px] font-medium text-[var(--color-accent-strong)]"
                          >
                            Confirmar cero
                          </SubmitTextButton>
                        </form>
                      ) : null}
                      {costStatus === "confirmed_zero" ? (
                        <form
                          action={removeProjectCostConfirmation.bind(
                            null,
                            id,
                            project.id,
                            periodDate,
                          )}
                        >
                          <SubmitTextButton
                            pendingLabel="Quitando…"
                            className="text-[12.5px] font-medium text-[var(--color-muted)]"
                          >
                            Quitar confirmación
                          </SubmitTextButton>
                        </form>
                      ) : null}
                      <Link
                        href={`${basePath}/${project.id}/quick-expense`}
                        className="text-[12.5px] font-medium text-[var(--color-accent-strong)]"
                      >
                        + Gasto
                      </Link>
                      <Link
                        href={`${basePath}/${project.id}/edit`}
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

      {paged && !loadError && totalPages > 1 ? (
        <div className="flex items-center justify-between text-[12.5px] text-[var(--color-muted)]">
          <span>
            Mostrando {(currentPage - 1) * PAGE_SIZE + 1}–{Math.min(currentPage * PAGE_SIZE, total)} de {total}
          </span>
          <div className="flex items-center gap-3">
            {currentPage > 1 ? (
              <Link href={pageHref(currentPage - 1)} className="font-medium text-[var(--color-accent-strong)]">
                Anterior
              </Link>
            ) : null}
            <span>
              Página {currentPage} de {totalPages}
            </span>
            {currentPage < totalPages ? (
              <Link href={pageHref(currentPage + 1)} className="font-medium text-[var(--color-accent-strong)]">
                Siguiente
              </Link>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
