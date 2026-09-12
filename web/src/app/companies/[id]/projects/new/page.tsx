import { redirect } from "next/navigation";
import { getSession, getCompanyForEdit, getClients, getBusinessAreas } from "@/lib/dal";
import { NewProjectForm } from "./form";

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
    <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 px-4 py-10">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-black dark:text-zinc-50">
          New project
        </h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-500">
          {membership.company.name}
        </p>
      </div>
      {activeClients.length === 0 || activeAreas.length === 0 ? (
        <div className="flex flex-col gap-2 rounded-md border border-zinc-200 bg-zinc-50 p-4 text-sm text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
          <p>
            You need at least one client and one business area before
            creating a project -- add them first.
          </p>
          <div className="flex gap-4">
            <a
              className="font-medium text-black underline dark:text-zinc-50"
              href={`/companies/${id}/clients`}
            >
              Go to Clients
            </a>
            <a
              className="font-medium text-black underline dark:text-zinc-50"
              href={`/companies/${id}/areas`}
            >
              Go to Business Areas
            </a>
          </div>
        </div>
      ) : (
        <NewProjectForm
          companyId={id}
          clients={activeClients}
          areas={activeAreas}
        />
      )}
    </div>
  );
}
