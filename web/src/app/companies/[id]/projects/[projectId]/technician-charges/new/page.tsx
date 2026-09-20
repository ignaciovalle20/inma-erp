import { redirect, notFound } from "next/navigation";
import { getSession, getCompanyForEdit, getProjects, getPersonnel } from "@/lib/dal";
import { defaultVatRate } from "@/lib/technicians";
import { ChargeForm } from "../charge-form";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/Card";
import { EmptyState } from "@/components/EmptyState";
import { LinkButton } from "@/components/Button";

export default async function NewTechnicianChargePage({
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

  const [projects, personnel] = await Promise.all([getProjects(id), getPersonnel(id)]);
  const project = projects.find((candidate) => candidate.id === projectId);

  if (!project) {
    notFound();
  }

  const technicians = personnel
    .filter((person) => person.type === "contractor" && person.active)
    .map((person) => ({
      id: person.id,
      name: person.name,
      payment_document: person.payment_document,
      default_rates: person.default_rates,
    }));

  return (
    <div className="mx-auto flex w-full max-w-lg flex-col gap-5">
      <PageHeader
        eyebrow="GESTIÓN / TRABAJOS"
        title="Cargo de técnico"
        subtitle={[project.name, project.client_name].filter(Boolean).join(" · ")}
      />
      <Card padding="24px">
        {technicians.length === 0 ? (
          <EmptyState
            message="Todavía no hay técnicos externos activos. Creá uno en Personal para poder cargarle trabajos."
            action={
              <LinkButton href={`/companies/${id}/personnel/new`} variant="primary">
                Nuevo técnico
              </LinkButton>
            }
          />
        ) : (
          <ChargeForm
            mode="create"
            companyId={id}
            projectId={projectId}
            technicians={technicians}
            currency={membership.company.currency}
            vatRate={defaultVatRate(membership.company.currency)}
          />
        )}
      </Card>
    </div>
  );
}
