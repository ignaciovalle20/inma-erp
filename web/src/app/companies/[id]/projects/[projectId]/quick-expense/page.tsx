import { redirect, notFound } from "next/navigation";
import { getSession, getCompanyForEdit, getProjects } from "@/lib/dal";
import { QuickCostEntryForm } from "./form";

export default async function QuickCostEntryPage({
  params,
}: {
  params: Promise<{ id: string; projectId: string }>;
}) {
  const { id, projectId } = await params;
  const user = await getSession();

  if (!user) {
    redirect("/login");
  }

  const membership = await getCompanyForEdit(id);

  if (!membership) {
    redirect("/companies");
  }

  const projects = await getProjects(id);
  const project = projects.find((candidate) => candidate.id === projectId);

  if (!project) {
    notFound();
  }

  return (
    <div className="mx-auto flex w-full max-w-lg flex-1 flex-col justify-center gap-6 px-4 py-10">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-black dark:text-zinc-50">
          Agregar gasto
        </h1>
        <p className="text-sm text-[var(--color-muted)]">
          {project.name}
          {project.client_name ? ` · ${project.client_name}` : ""}
        </p>
      </div>
      <QuickCostEntryForm companyId={id} projectId={projectId} />
    </div>
  );
}
