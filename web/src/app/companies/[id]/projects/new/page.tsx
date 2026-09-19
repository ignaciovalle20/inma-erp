import { redirect } from "next/navigation";
import { getSession, getCompanyForEdit, getClients, getBusinessAreas, getProjects } from "@/lib/dal";
import { NewProjectForm } from "./form";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/Card";
import { LinkButton } from "@/components/Button";

export default async function NewProjectPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ repeat_from?: string }>;
}) {
  const { id } = await params;
  const { repeat_from: repeatFrom } = await searchParams;
  const user = await getSession();

  if (!user) {
    redirect("/login");
  }

  const membership = await getCompanyForEdit(id);

  if (!membership) {
    redirect("/companies");
  }

  const [clients, areas, projects] = await Promise.all([
    getClients(id),
    getBusinessAreas(id),
    getProjects(id),
  ]);

  const activeClients = clients.filter((client) => client.active);
  const activeAreas = areas.filter((area) => area.active);

  // "Repetir del mes anterior" (docs/cambios-flujo-v2.md 4.1): the
  // source job's client/área/descripción/facturable are prefilled, but
  // quote_number and budget are always left blank -- the whole point is
  // that only those two change month to month.
  const sourceProject = repeatFrom
    ? projects.find((project) => project.id === repeatFrom)
    : undefined;

  return (
    <div className="mx-auto flex w-full max-w-[520px] flex-col gap-5">
      <PageHeader
        eyebrow="GESTIÓN / TRABAJOS"
        title={sourceProject ? "Repetir trabajo" : "Nuevo trabajo"}
        subtitle={membership.company.name}
      />
      {activeClients.length === 0 || activeAreas.length === 0 ? (
        <Card className="flex flex-col gap-3">
          <p className="text-[13px] text-[var(--color-ink-2)]">
            Necesitás al menos un cliente y un área de negocio antes de crear
            un proyecto -- agregalos primero.
          </p>
          <div className="flex gap-3">
            <LinkButton href={`/companies/${id}/clients`} variant="secondary">
              Ir a Clientes
            </LinkButton>
            <LinkButton href={`/companies/${id}/areas`} variant="secondary">
              Ir a Áreas
            </LinkButton>
          </div>
        </Card>
      ) : (
        <Card>
          <NewProjectForm
            companyId={id}
            clients={activeClients}
            areas={activeAreas}
            currency={membership.company.currency}
            initialValues={
              sourceProject
                ? {
                    name: sourceProject.name,
                    client_id: sourceProject.client_id,
                    business_area_id: sourceProject.business_area_id,
                    invoiceable: sourceProject.invoiceable,
                  }
                : undefined
            }
          />
        </Card>
      )}
    </div>
  );
}
