import { redirect } from "next/navigation";
import { getSession, getCompanyForEdit, getSuppliers } from "@/lib/dal";
import { NewCostPoolForm } from "./form";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/Card";

export default async function NewCostPoolPage({
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

  const suppliers = await getSuppliers(id);

  return (
    <div className="mx-auto flex w-full max-w-[560px] flex-col gap-5">
      <PageHeader
        eyebrow="CONFIGURACIÓN / SERVICIOS RECURRENTES"
        title="Nuevo pool de costo"
        subtitle={membership.company.name}
        back={{
          href: `/companies/${id}/recurring-services/cost-pools`,
          label: "Pools de costo",
        }}
      />
      <Card>
        <NewCostPoolForm companyId={id} suppliers={suppliers} />
      </Card>
    </div>
  );
}
