import Link from "next/link";
import { redirect } from "next/navigation";
import {
  getSession,
  getCompanyForEdit,
  getProjectCostStatus,
  type ProjectCostStatus,
} from "@/lib/dal";
import { confirmProjectCostZero, removeProjectCostConfirmation } from "./actions";
import { PageHeader } from "@/components/PageHeader";
import { PeriodPicker } from "@/components/PeriodPicker";
import { LinkButton } from "@/components/Button";
import { Badge, type BadgeVariant } from "@/components/Badge";
import { Money } from "@/components/Money";
import { TableCard, Th, Td, Tr } from "@/components/Table";
import { EmptyState } from "@/components/EmptyState";
import { SubmitTextButton } from "@/components/SubmitTextButton";
import { PROJECT_STATUS_LABEL, PROJECT_STATUS_BADGE_VARIANT } from "@/lib/projectStatus";
import { MONTH_PATTERN } from "@/lib/period";

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

function currentMonth(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

export default async function ProjectsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ period?: string }>;
}) {
  const { id } = await params;
  const { period: periodParam } = await searchParams;
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

  const period = MONTH_PATTERN.test(periodParam ?? "")
    ? (periodParam as string)
    : currentMonth();
  const periodDate = `${period}-01`;

  let projects: Awaited<ReturnType<typeof getProjectCostStatus>> = [];
  let loadError: string | null = null;

  try {
    projects = await getProjectCostStatus(id, periodDate);
  } catch (thrown) {
    console.error(thrown);
    loadError = thrown instanceof Error ? thrown.message : "No se pudo leer el estado de los proyectos.";
  }

  return (
    <div className="flex flex-col gap-[18px]">
      <PageHeader
        eyebrow="GESTIÓN / PROYECTOS"
        title="Proyectos"
        subtitle={membership.company.name}
        actions={
          <>
            <PeriodPicker period={period} basePath={`/companies/${id}/projects`} />
            <LinkButton href={`/companies/${id}/projects/board`} variant="secondary">
              Tablero
            </LinkButton>
            <LinkButton href={`/companies/${id}/projects/new`} variant="primary">
              Nuevo trabajo
            </LinkButton>
          </>
        }
      />

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
                <EmptyState message="No hay proyectos activos para esta empresa." />
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
              <Th>Costo del mes</Th>
              <Th align="right">Presupuesto</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {projects.map((project) => (
              <Tr key={project.id}>
                <Td className="font-medium text-[var(--color-ink)]">
                  <Link href={`/companies/${id}/projects/${project.id}`}>
                    {project.name}
                  </Link>
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
                <Td>
                  <Badge variant={COST_STATUS_VARIANT[project.cost_status]}>
                    {COST_STATUS_LABEL[project.cost_status]}
                  </Badge>
                </Td>
                <Td align="right">
                  {project.budget != null ? (
                    <Money value={project.budget} currency={membership.company.currency} showCurrency={false} />
                  ) : (
                    "—"
                  )}
                </Td>
                <Td align="right">
                  <div className="flex items-center justify-end gap-3">
                    {project.cost_status === "pending" ? (
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
                    {project.cost_status === "confirmed_zero" ? (
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
                      href={`/companies/${id}/projects/${project.id}/quick-expense`}
                      className="text-[12.5px] font-medium text-[var(--color-accent-strong)]"
                    >
                      + Gasto
                    </Link>
                    <Link
                      href={`/companies/${id}/projects/${project.id}/edit`}
                      className="text-[12.5px] font-medium text-[var(--color-accent-strong)]"
                    >
                      Editar
                    </Link>
                  </div>
                </Td>
              </Tr>
            ))}
          </tbody>
        </TableCard>
      )}
    </div>
  );
}
