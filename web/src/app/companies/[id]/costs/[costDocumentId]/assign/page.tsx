import { redirect } from "next/navigation";
import {
  getSession,
  getCompanyForEdit,
  getCostDocumentForEdit,
  getProjects,
} from "@/lib/dal";
import { AssignCostDocumentForm } from "./form";
import { getLinkedDocumentIds } from "@/lib/technicianDal";
import { TechnicianLinkedNotice } from "@/components/TechnicianLinkedNotice";
import { PageHeader } from "@/components/PageHeader";
import { backTarget } from "@/lib/backNavigation";
import { LinkButton } from "@/components/Button";

export default async function AssignCostDocumentPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; costDocumentId: string }>;
  searchParams: Promise<{ volver?: string }>;
}) {
  const { id, costDocumentId } = await params;
  const { volver } = await searchParams;
  const user = await getSession();

  if (!user) {
    redirect("/login");
  }

  const membership = await getCompanyForEdit(id);

  if (!membership) {
    redirect("/companies");
  }

  const [document, projects, linked] = await Promise.all([
    getCostDocumentForEdit(id, costDocumentId),
    getProjects(id),
    getLinkedDocumentIds(id, costDocumentId).then(
      (ids) => ids.has(costDocumentId),
      () => false,
    ),
  ]);

  if (!document) {
    redirect(`/companies/${id}/costs`);
  }

  const activeProjects = projects.filter(
    (project) => project.status !== "cerrado" && project.status !== "cancelado",
  );

  return (
    <div className="mx-auto flex w-full max-w-[480px] flex-col gap-5">
      <PageHeader
        eyebrow="GESTIÓN / COSTOS / DOCUMENTO"
        title="Asignar a un trabajo"
        subtitle='Todo el costo se imputa a un único trabajo -- para repartirlo entre varios, usá "Dividir" en su lugar.'
        back={backTarget(id, volver, { href: `/companies/${id}/costs/${costDocumentId}`, label: "Volver al documento" })}
      />
      {linked ? (
        <TechnicianLinkedNotice companyId={id} costDocumentId={costDocumentId} />
      ) : document.classification !== "general" ? (
        <div className="flex flex-col gap-3 rounded-[10px] border border-[var(--color-warning-soft-border)] bg-[var(--color-warning-panel)] p-4 text-[13px] text-[var(--color-warning-ink)]">
          <p>Este documento ya está asignado a un trabajo.</p>
          <LinkButton href={`/companies/${id}/costs`} variant="secondary" className="w-fit">
            Volver a documentos de costo
          </LinkButton>
        </div>
      ) : (
        <AssignCostDocumentForm
          companyId={id}
          costDocumentId={costDocumentId}
          projects={activeProjects}
          volver={volver ?? null}
        />
      )}
    </div>
  );
}
