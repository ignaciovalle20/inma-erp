import { redirect } from "next/navigation";
import {
  getSession,
  getCompanyForEdit,
  getProjectForEdit,
  getClients,
  getBusinessAreas,
} from "@/lib/dal";
import { EditProjectForm } from "./form";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/Card";

export default async function EditProjectPage({
  params,
}: {
  params: Promise<{ id: string; projectId: string }>;
}) {
  const { id, projectId } = await params;
  const user = await getSession();

  if (!user) {
    redirect("/login");
  }

  const [membership, project] = await Promise.all([
    getCompanyForEdit(id),
    getProjectForEdit(id, projectId),
  ]);

  if (!membership) {
    redirect("/companies");
  }

  if (!project) {
    redirect(`/companies/${id}/projects`);
  }

  const [clients, areas] = await Promise.all([
    getClients(id),
    getBusinessAreas(id),
  ]);

  // Include the currently-assigned client/area even if inactive, so the
  // select doesn't silently drop the existing selection.
  const clientOptions = clients.filter(
    (client) => client.active || client.id === project.client_id,
  );
  const areaOptions = areas.filter(
    (area) => area.active || area.id === project.business_area_id,
  );

  return (
    <div className="mx-auto flex w-full max-w-[520px] flex-col gap-5">
      <PageHeader eyebrow="GESTIÓN / PROYECTOS" title={`Editar ${project.name}`} />
      <Card>
        <EditProjectForm
          companyId={id}
          project={project}
          clients={clientOptions}
          areas={areaOptions}
          currency={membership.company.currency}
        />
      </Card>
    </div>
  );
}
