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
        eyebrow="GESTIÓN / COSTOS / REPARTO LICENCIAS MS"
        title="Nuevo reparto de licencias MS"
        subtitle={membership.company.name}
        back={{
          href: `/companies/${id}/costs/ms-licenses`,
          label: "Reparto licencias MS",
        }}
      />
      <Card>
        <NewCostPoolForm companyId={id} country={membership.company.country} suppliers={suppliers} />
      </Card>
    </div>
  );
}
