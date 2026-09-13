import { redirect } from "next/navigation";
import { getSession, getCompanyForEdit, getClients, getBusinessAreas } from "@/lib/dal";
import { NewProjectForm } from "./form";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/Card";
import { LinkButton } from "@/components/Button";

export default async function NewProjectPage({
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

  const [clients, areas] = await Promise.all([
    getClients(id),
    getBusinessAreas(id),
  ]);

  const activeClients = clients.filter((client) => client.active);
  const activeAreas = areas.filter((area) => area.active);

  return (
    <div className="mx-auto flex w-full max-w-[520px] flex-col gap-5">
      <PageHeader
        eyebrow="GESTIÓN / PROYECTOS"
        title="Nuevo proyecto"
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
          <NewProjectForm companyId={id} clients={activeClients} areas={activeAreas} />
        </Card>
      )}
    </div>
  );
}
