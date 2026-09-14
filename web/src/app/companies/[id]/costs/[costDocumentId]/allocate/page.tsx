import { redirect } from "next/navigation";
import {
  getSession,
  getCompanyForEdit,
  getCostDocumentForEdit,
  getCostAllocations,
  getProjects,
  getClients,
  getBusinessAreas,
} from "@/lib/dal";
import { CostAllocationForm } from "./form";

export default async function AllocateCostDocumentPage({
  params,
}: {
  params: Promise<{ id: string; costDocumentId: string }>;
}) {
  const { id, costDocumentId } = await params;
  const user = await getSession();

  if (!user) {
    redirect("/login");
  }

  const membership = await getCompanyForEdit(id);

  if (!membership) {
    redirect("/companies");
  }

  const [document, allocations, projects, clients, businessAreas] = await Promise.all([
    getCostDocumentForEdit(id, costDocumentId),
    getCostAllocations(costDocumentId),
    getProjects(id),
    getClients(id),
    getBusinessAreas(id),
  ]);

  if (!document) {
    redirect(`/companies/${id}/costs`);
  }

  const activeProjects = projects.filter((project) => project.status !== "closed");
  const activeClients = clients.filter((client) => client.active);
  const activeBusinessAreas = businessAreas.filter((area) => area.active);

  return (
    <div className="mx-auto flex w-full max-w-lg flex-1 flex-col justify-center gap-6 px-4 py-10">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-black dark:text-zinc-50">
          Allocate cost
        </h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-500">
          {membership.company.name}
        </p>
      </div>
      {document.classification !== "general" ? (
        <div className="flex flex-col gap-2 rounded-md border border-zinc-200 bg-zinc-50 p-4 text-sm text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
          <p>
            Only general (overhead) cost documents can be allocated. This
            document is a direct cost, already tied to a single project.
          </p>
          <a
            className="font-medium text-black underline dark:text-zinc-50"
            href={`/companies/${id}/costs`}
          >
            Back to cost documents
          </a>
        </div>
      ) : (
        <CostAllocationForm
          companyId={id}
          document={document}
          allocations={allocations}
          projects={activeProjects}
          clients={activeClients}
          businessAreas={activeBusinessAreas}
        />
      )}
    </div>
  );
}
