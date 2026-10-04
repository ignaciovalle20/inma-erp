import { redirect } from "next/navigation";
import { getSession, getCompanyForEdit, getClients, getBusinessAreas } from "@/lib/dal";
import { NewRecurringServiceForm } from "./form";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/Card";
import { serviceCountry } from "@/lib/recurringServiceTypes";

export default async function NewRecurringServicePage({
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

  const [clients, businessAreas] = await Promise.all([
    getClients(id),
    getBusinessAreas(id),
  ]);

  return (
    <div className="mx-auto flex w-full max-w-[560px] flex-col gap-5">
      <PageHeader
        eyebrow="GESTIÓN / SERVICIOS RECURRENTES"
        title="Nuevo servicio recurrente"
        subtitle={membership.company.name}
      />
      <Card>
        <NewRecurringServiceForm
          companyId={id}
          clients={clients}
          businessAreas={businessAreas}
          country={serviceCountry(membership.company.country)}
        />
      </Card>
    </div>
  );
}
