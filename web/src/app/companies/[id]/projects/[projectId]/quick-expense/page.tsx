import { redirect, notFound } from "next/navigation";
import { getSession, getCompanyForEdit, getProjects } from "@/lib/dal";
import { QuickCostEntryForm } from "./form";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/Card";

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
    <div className="mx-auto flex w-full max-w-lg flex-col gap-5">
      <PageHeader
        eyebrow="GESTIÓN / TRABAJOS"
        title="Agregar gasto"
        subtitle={[project.name, project.client_name].filter(Boolean).join(" · ")}
      />
      <Card padding="24px">
        <QuickCostEntryForm companyId={id} projectId={projectId} />
      </Card>
    </div>
  );
}
