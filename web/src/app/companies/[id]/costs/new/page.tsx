import { redirect } from "next/navigation";
import { getSession, getCompanyForEdit, getSuppliers, getProjects } from "@/lib/dal";
import { NewCostDocumentForm } from "./form";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/Card";

export default async function NewCostDocumentPage({
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

  const [suppliers, projects] = await Promise.all([
    getSuppliers(id),
    getProjects(id),
  ]);

  const activeSuppliers = suppliers.filter((supplier) => supplier.active);
  const activeProjects = projects.filter((project) => project.status === "active");

  return (
    <div className="mx-auto flex w-full max-w-[700px] flex-col gap-5">
      <PageHeader
        eyebrow="GESTIÓN / COSTOS"
        title="Nuevo documento de costo"
        subtitle={membership.company.name}
      />
      <Card padding="0">
        <NewCostDocumentForm
          companyId={id}
          suppliers={activeSuppliers}
          projects={activeProjects}
          defaultCurrency={membership.company.currency}
        />
      </Card>
    </div>
  );
}
