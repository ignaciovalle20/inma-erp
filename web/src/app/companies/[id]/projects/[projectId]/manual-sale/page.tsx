import { redirect, notFound } from "next/navigation";
import { getSession, getCompanyForEdit, getProjects } from "@/lib/dal";
import { ManualSaleForm } from "./form";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/Card";

export default async function ManualSalePage({
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
        title="Registrar venta sin factura"
        subtitle={[project.name, project.client_name].filter(Boolean).join(" · ")}
        back={{ href: `/companies/${id}/projects/${projectId}`, label: "Volver al trabajo" }}
      />
      <Card padding="24px">
        <ManualSaleForm companyId={id} projectId={projectId} currency={membership.company.currency} />
      </Card>
    </div>
  );
}
