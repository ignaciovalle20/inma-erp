import {
  getSession,
  getCompanyForEdit,
  getCostDocumentForEdit,
  getCostAllocations,
  getProjects,
  getClients,
  getBusinessAreas,
} from "@/lib/dal";
import { redirect } from "next/navigation";
import { CostAllocationForm } from "./form";
import { PageHeader } from "@/components/PageHeader";
import { LinkButton } from "@/components/Button";

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
    <div className="mx-auto flex w-full max-w-[560px] flex-col gap-[18px]">
      <PageHeader
        eyebrow="GESTIÓN / COSTOS / DOCUMENTO"
        title="Editar asignación"
        subtitle="Repartí este costo general entre proyectos, clientes o áreas."
      />
      {document.classification !== "general" ? (
        <div className="flex flex-col gap-3 rounded-[10px] border border-[var(--color-warning-soft-border)] bg-[var(--color-warning-panel)] p-4 text-[13px] text-[var(--color-warning-ink)]">
          <p>
            Solo los costos generales se asignan. Este documento es un costo
            directo, ya imputado a un único proyecto.
          </p>
          <LinkButton
            href={`/companies/${id}/costs`}
            variant="secondary"
            className="w-fit"
          >
            Volver a documentos de costo
          </LinkButton>
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
