import { redirect } from "next/navigation";
import {
  getSession,
  getProjectForEdit,
  getClients,
  getBusinessAreas,
} from "@/lib/dal";
import { EditProjectForm } from "./form";

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

  const project = await getProjectForEdit(id, projectId);

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
    <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 px-4 py-10">
      <h1 className="text-xl font-semibold text-black dark:text-zinc-50">
        Edit {project.name}
      </h1>
      <EditProjectForm
        companyId={id}
        project={project}
        clients={clientOptions}
        areas={areaOptions}
      />
    </div>
  );
}
