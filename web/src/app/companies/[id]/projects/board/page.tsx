import Link from "next/link";
import { redirect } from "next/navigation";
import {
  getSession,
  getCompanyForEdit,
  getProjects,
  getBusinessAreas,
  getProjectQuotesByProject,
} from "@/lib/dal";
import { updateProjectStatus } from "./actions";
import { BoardFilters } from "./filters";
import { PageHeader } from "@/components/PageHeader";
import { LinkButton } from "@/components/Button";
import { Badge, type BadgeVariant } from "@/components/Badge";
import { DataIncompleteBanner } from "@/components/DataIncompleteBanner";
import { getTechnicianCharges } from "@/lib/technicianDal";
import {
  summarizeByProject,
  type PaymentStatus,
  type ProjectTechnicianSummary,
} from "@/lib/technicians";
import { ProjectStatusSelect } from "@/components/ProjectStatusSelect";
import { PROJECT_STATUSES, PROJECT_STATUS_LABEL } from "@/lib/projectStatus";

// Short card labels, one line each ("Técnico: sin pagar" used to wrap).
const TECHNICIAN_PAYMENT_LABEL: Record<PaymentStatus, string> = {
  sin_pagar: "Técnico sin pagar",
  parcial: "Técnico pago parcial",
  pagado: "Técnico pagado",
};

const TECHNICIAN_PAYMENT_VARIANT: Record<PaymentStatus, BadgeVariant> = {
  sin_pagar: "neutral",
  parcial: "warning",
  pagado: "positive",
};

export default async function ProjectsBoardPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ area?: string; responsible?: string }>;
}) {
  const { id } = await params;
  const { area, responsible } = await searchParams;
  const user = await getSession();

  if (!user) {
    redirect("/login");
  }

  const membership = await getCompanyForEdit(id);

  if (!membership) {
    redirect("/companies");
  }

  const [projects, areas] = await Promise.all([
    getProjects(id),
    getBusinessAreas(id),
  ]);

  const filteredProjects = projects.filter(
    (project) =>
      (!area || project.business_area_id === area) &&
      (!responsible || project.responsible === responsible),
  );

  const quotesByProject = await getProjectQuotesByProject(
    id,
    filteredProjects.map((project) => project.id),
  );

  // How each job stands with its external technicians (payment and boleta). A
  // failed read is said above the board: no indicators would read as "nothing pending".
  let technicianSummary = new Map<string, ProjectTechnicianSummary>();
  let technicianReadFailed = false;
  try {
    technicianSummary = summarizeByProject(await getTechnicianCharges(id));
  } catch (error) {
    console.error(error);
    technicianReadFailed = true;
  }

  const responsibles = Array.from(
    new Set(
      projects
        .map((project) => project.responsible)
        .filter((value): value is string => Boolean(value)),
    ),
  ).sort();

  const updateStatusWithCompany = updateProjectStatus.bind(null, id);

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <PageHeader
        eyebrow="GESTIÓN / TRABAJOS"
        title="Tablero"
        subtitle={membership.company.name}
        actions={
          <>
            <BoardFilters
              basePath={`/companies/${id}/projects/board`}
              areas={areas}
              responsibles={responsibles}
              area={area ?? ""}
              responsible={responsible ?? ""}
            />
            <LinkButton href={`/companies/${id}/projects`} variant="secondary">
              Lista
            </LinkButton>
            <LinkButton href={`/companies/${id}/projects/new`} variant="primary">
              Nuevo trabajo
            </LinkButton>
          </>
        }
      />

      {technicianReadFailed ? (
        <DataIncompleteBanner details={["los cargos de los técnicos (no se muestran sus indicadores en las tarjetas)"]} />
      ) : null}

      {/* The board scrolls sideways inside this strip (never the whole
          page) when the 6 columns don't fit; on a phone each column snaps
          into view. Each column scrolls vertically on its own under a
          header that stays put. */}
      <div
        aria-label="Trabajos por estado"
        className="-mx-4 flex snap-x snap-mandatory scroll-px-4 items-start gap-3 overflow-x-auto overscroll-x-contain px-4 pb-2 md:mx-0 md:snap-none md:px-0"
      >
        {PROJECT_STATUSES.map((status) => {
          const columnProjects = filteredProjects.filter(
            (project) => project.status === status,
          );
          const headingId = `board-column-${status}`;

          return (
            <section
              key={status}
              aria-labelledby={headingId}
              className="flex max-h-[calc(100dvh-12rem)] min-h-40 w-[85vw] max-w-[320px] flex-none snap-start flex-col rounded-card border border-[var(--color-hairline-soft)] bg-[color-mix(in_srgb,var(--color-ink)_3%,transparent)] md:w-auto md:min-w-[280px] md:max-w-none md:flex-1 md:basis-0"
            >
              <header className="sticky top-0 z-[1] flex flex-none items-center justify-between gap-2 px-3 pb-2 pt-3">
                <h2 id={headingId} className="caps-label truncate text-[var(--color-muted)]">
                  {PROJECT_STATUS_LABEL[status]}
                </h2>
                <span className="rounded-full bg-[var(--color-surface)] px-2 font-mono text-caption tabular-nums text-[var(--color-muted)]">
                  {columnProjects.length}
                </span>
              </header>

              <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-y-contain px-2 pb-2">
                {columnProjects.length === 0 ? (
                  <div className="flex min-h-24 flex-none items-center justify-center rounded-card border border-dashed border-[var(--color-hairline)] text-small text-[var(--color-faint)]">
                    Sin trabajos
                  </div>
                ) : (
                  columnProjects.map((project) => {
                    const quoteNumbers = quotesByProject.get(project.id) ?? [];
                    const technicians = technicianSummary.get(project.id);
                    const meta = [project.client_name, project.business_area_name]
                      .filter(Boolean)
                      .join(" · ");

                    return (
                      <article
                        key={project.id}
                        data-board-card
                        className="surface-card card-interactive flex min-w-0 flex-none flex-col gap-2 overflow-hidden p-3"
                      >
                        <Link
                          href={`/companies/${id}/projects/${project.id}`}
                          title={project.name}
                          className="line-clamp-2 text-body font-medium text-[var(--color-ink)] no-underline wrap-anywhere hover:underline"
                        >
                          {project.name}
                        </Link>
                        {meta ? (
                          <p title={meta} className="-mt-1 truncate text-small text-[var(--color-faint)]">
                            {meta}
                          </p>
                        ) : null}

                        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                          {quoteNumbers.map((quoteNumber) => (
                            <Badge key={quoteNumber} variant="outline" title={`Cotización ${quoteNumber}`}>
                              {quoteNumber}
                            </Badge>
                          ))}
                          {quoteNumbers.length === 0 ? (
                            <Badge variant="neutral">Sin cotización</Badge>
                          ) : null}
                          <Badge variant={project.invoiceable ? "positive" : "neutral"}>
                            {project.invoiceable ? "Facturable" : "No facturable"}
                          </Badge>
                          {technicianReadFailed || !technicians ? null : (
                            <>
                              <Badge variant={TECHNICIAN_PAYMENT_VARIANT[technicians.payment]}>
                                {TECHNICIAN_PAYMENT_LABEL[technicians.payment]}
                              </Badge>
                              <Badge variant={technicians.document === "recibida" ? "positive" : "warning"}>
                                {technicians.document === "recibida" ? "Boleta recibida" : "Boleta pendiente"}
                              </Badge>
                            </>
                          )}
                        </div>

                        {technicianReadFailed || technicians ? null : (
                          <span className="text-caption text-[var(--color-faint)]">Sin cargos de técnico</span>
                        )}

                        <ProjectStatusSelect
                          projectId={project.id}
                          status={project.status}
                          holdReason={project.hold_reason}
                          updateStatus={updateStatusWithCompany}
                        />
                      </article>
                    );
                  })
                )}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
