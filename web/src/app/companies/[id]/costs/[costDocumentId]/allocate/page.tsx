import {
  getSession,
  getCompanyForEdit,
  getCostDocumentForEdit,
  getCostAllocations,
  getProjects,
  getClients,
  getBusinessAreas,
  getMsLicenseCoverageContext,
} from "@/lib/dal";
import { redirect } from "next/navigation";
import { getCostServiceAllocations, getServicePeriodOptions } from "@/lib/costServiceAllocations";
import { serviceGrossAmounts } from "@/lib/allocations";
import { currencyDecimals } from "@/lib/currencies";
import { CostAllocationForm } from "./form";
import { getLinkedDocumentIds } from "@/lib/technicianDal";
import { TechnicianLinkedNotice } from "@/components/TechnicianLinkedNotice";
import type { AllocationRowInput } from "./actions";
import { PageHeader } from "@/components/PageHeader";
import { backTarget } from "@/lib/backNavigation";
import { LinkButton } from "@/components/Button";

export default async function AllocateCostDocumentPage({
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

  const [document, allocations, serviceAllocations, projects, clients, businessAreas, msLicenseCoverage, linked] =
    await Promise.all([
      getCostDocumentForEdit(id, costDocumentId),
      getCostAllocations(costDocumentId),
      getCostServiceAllocations(id, { costDocumentId, status: "confirmed" }),
      getProjects(id),
      getClients(id),
      getBusinessAreas(id),
      getMsLicenseCoverageContext(id),
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
  const activeClients = clients.filter((client) => client.active);
  const activeBusinessAreas = businessAreas.filter((area) => area.active);

  // Recurring services take a positive cost not already carried by the MS
  // licenses pool (the database refuses anything else); periods already
  // allocated stay selectable.
  const month = (document.recognized_period ?? document.document_date).slice(0, 7);
  const serviceOptions =
    document.total_amount > 0 && !document.covered_by_cost_pool_id
      ? await getServicePeriodOptions(
          id,
          month,
          document.supplier_id,
          serviceAllocations.map((row) => row.costPeriodId),
        )
      : [];

  // Both kinds of rows, in the order they were saved. Service rows are shown
  // on the total's basis (IVA included), like every other row.
  const serviceGross = serviceGrossAmounts(
    serviceAllocations,
    document.net_amount,
    document.total_amount,
    currencyDecimals(document.currency),
  );
  const savedRows: { position: number; row: AllocationRowInput }[] = [
    ...allocations.map((allocation) => ({
      position: allocation.position,
      row: {
        target_type: allocation.target_type,
        target_id: allocation.target_id,
        method: allocation.method,
        value: String(allocation.method === "percentage" ? allocation.percentage : allocation.amount),
      },
    })),
    // Rows from "Asignar a servicios" have no position: they go last.
    ...serviceAllocations.map((allocation, index) => ({
      position: allocation.position ?? Number.MAX_SAFE_INTEGER,
      row: {
        target_type: "service" as const,
        target_id: allocation.costPeriodId,
        method: "fixed_amount" as const,
        value: String(serviceGross[index]),
      },
    })),
  ];
  const initialRows = savedRows.sort((a, b) => a.position - b.position).map(({ row }) => row);

  return (
    <div className="mx-auto flex w-full max-w-[560px] flex-col gap-5">
      <PageHeader
        eyebrow="GESTIÓN / COSTOS / DOCUMENTO"
        title="Editar asignación"
        subtitle="Repartí este costo general entre proyectos, clientes, áreas o servicios recurrentes."
        back={backTarget(id, volver, { href: `/companies/${id}/costs/${costDocumentId}`, label: "Volver al documento" })}
      />
      {linked ? (
        <TechnicianLinkedNotice companyId={id} costDocumentId={costDocumentId} />
      ) : document.classification !== "general" ? (
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
          initialRows={initialRows}
          serviceOptions={serviceOptions}
          projects={activeProjects}
          clients={activeClients}
          businessAreas={activeBusinessAreas}
          msLicenseCoverage={msLicenseCoverage}
          projectAreaById={Object.fromEntries(projects.map((project) => [project.id, project.business_area_id]))}
        />
      )}
    </div>
  );
}
