import { redirect } from "next/navigation";
import {
  getSession,
  getCompanyForEdit,
  getRecurringServiceForEdit,
  getClients,
  getBusinessAreas,
} from "@/lib/dal";
import { EditRecurringServiceForm } from "./form";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/Card";
import { serviceCountry } from "@/lib/recurringServiceTypes";

export default async function EditRecurringServicePage({
  params,
}: {
  params: Promise<{ id: string; recurringServiceId: string }>;
}) {
  const { id, recurringServiceId } = await params;
  const user = await getSession();

  if (!user) {
    redirect("/login");
  }

  const [membership, recurringService, clients, businessAreas] = await Promise.all([
    getCompanyForEdit(id),
    getRecurringServiceForEdit(id, recurringServiceId),
    getClients(id),
    getBusinessAreas(id),
  ]);

  if (!membership || !recurringService) {
    redirect(`/companies/${id}/recurring-services/services`);
  }

  return (
    <div className="mx-auto flex w-full max-w-[560px] flex-col gap-5">
      <PageHeader
        eyebrow="GESTIÓN / SERVICIOS RECURRENTES"
        title={`Editar ${recurringService.name}`}
        subtitle={membership.company.name}
        back={{
          href: `/companies/${id}/recurring-services/services/${recurringServiceId}`,
          label: recurringService.name,
        }}
      />
      <Card>
        <EditRecurringServiceForm
          companyId={id}
          clients={clients}
          businessAreas={businessAreas}
          recurringService={recurringService}
          country={serviceCountry(membership.company.country)}
        />
      </Card>
    </div>
  );
}
