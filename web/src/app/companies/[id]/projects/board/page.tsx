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
import { Badge } from "@/components/Badge";
import { ProjectStatusSelect } from "@/components/ProjectStatusSelect";
import { PROJECT_STATUSES, PROJECT_STATUS_LABEL } from "@/lib/projectStatus";

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

  const responsibles = Array.from(
    new Set(
      projects
        .map((project) => project.responsible)
        .filter((value): value is string => Boolean(value)),
    ),
  ).sort();

  const updateStatusWithCompany = updateProjectStatus.bind(null, id);

  return (
    <div className="flex flex-col gap-[18px]">
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

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        {PROJECT_STATUSES.map((status) => {
          const columnProjects = filteredProjects.filter(
            (project) => project.status === status,
          );

          return (
            <div key={status} className="flex flex-col gap-2">
              <div className="flex items-center justify-between px-0.5">
                <h2 className="font-mono text-[10.5px] font-medium uppercase tracking-[0.1em] text-[var(--color-muted)]">
                  {PROJECT_STATUS_LABEL[status]}
                </h2>
                <span className="font-mono text-[10.5px] text-[var(--color-faint)]">
                  {columnProjects.length}
                </span>
              </div>

              <div className="flex flex-col gap-2">
                {columnProjects.length === 0 ? (
                  <div className="rounded-[10px] border border-dashed border-[var(--color-hairline)] p-3 text-center text-[11.5px] text-[var(--color-muted)]">
                    Sin trabajos
                  </div>
                ) : (
                  columnProjects.map((project) => {
                    const quoteNumbers = quotesByProject.get(project.id) ?? [];

                    return (
                      <div
                        key={project.id}
                        className="flex flex-col gap-2 rounded-[10px] border border-[var(--color-hairline)] bg-[var(--color-surface)] p-3"
                      >
                        <Link
                          href={`/companies/${id}/projects/${project.id}`}
                          className="text-[13px] font-medium text-[var(--color-ink)]"
                        >
                          {project.name}
                        </Link>
                        <span className="text-[11.5px] text-[var(--color-faint)]">
                          {[project.client_name, project.business_area_name]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>

                        <div className="flex flex-wrap items-center gap-1.5">
                          {quoteNumbers.map((quoteNumber) => (
                            <Badge key={quoteNumber} variant="outline">
                              {quoteNumber}
                            </Badge>
                          ))}
                          {quoteNumbers.length === 0 ? (
                            <Badge variant="neutral">Sin cotización</Badge>
                          ) : null}
                          <Badge variant={project.invoiceable ? "positive" : "neutral"}>
                            {project.invoiceable ? "Facturable" : "No facturable"}
                          </Badge>
                        </div>

                        <ProjectStatusSelect
                          projectId={project.id}
                          status={project.status}
                          holdReason={project.hold_reason}
                          updateStatus={updateStatusWithCompany}
                        />
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
