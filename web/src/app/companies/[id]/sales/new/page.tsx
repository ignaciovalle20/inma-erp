import { redirect } from "next/navigation";
import { getSession, getCompanyForEdit, getClients, getProjects } from "@/lib/dal";
import { NewSalesDocumentForm } from "./form";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/Card";
import { LinkButton } from "@/components/Button";

export default async function NewSalesDocumentPage({
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

  const clients = await getClients(id);
  const activeClients = clients.filter((client) => client.active);
  const projects = await getProjects(id);
  const activeProjects = projects.filter((project) => project.status === "active");

  return (
    <div className="mx-auto flex w-full max-w-[700px] flex-col gap-5">
      <PageHeader
        eyebrow="GESTIÓN / VENTAS"
        title="Nuevo documento de venta"
        subtitle={membership.company.name}
      />
      {activeClients.length === 0 ? (
        <Card className="flex flex-col gap-3">
          <p className="text-[13px] text-[var(--color-ink-2)]">
            Necesitás al menos un cliente antes de crear un documento de
            venta -- agregá uno primero.
          </p>
          <LinkButton href={`/companies/${id}/clients`} variant="secondary" className="self-start">
            Ir a Clientes
          </LinkButton>
        </Card>
      ) : (
        <Card padding="0">
          <NewSalesDocumentForm
            companyId={id}
            clients={activeClients}
            projects={activeProjects}
            defaultCurrency={membership.company.currency}
          />
        </Card>
      )}
    </div>
  );
}
