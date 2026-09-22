import { redirect } from "next/navigation";
import {
  getSession,
  getRecurringServiceForEdit,
  getClients,
  getBusinessAreas,
} from "@/lib/dal";
import { EditRecurringServiceForm } from "./form";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/Card";

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

  const [recurringService, clients, businessAreas] = await Promise.all([
    getRecurringServiceForEdit(id, recurringServiceId),
    getClients(id),
    getBusinessAreas(id),
  ]);

  if (!recurringService) {
    redirect(`/companies/${id}/recurring-services`);
  }

  return (
    <div className="mx-auto flex w-full max-w-[560px] flex-col gap-5">
      <PageHeader
        eyebrow="CONFIGURACIÓN / SERVICIOS RECURRENTES"
        title={`Editar ${recurringService.name}`}
      />
      <Card>
        <EditRecurringServiceForm
          companyId={id}
          clients={clients}
          businessAreas={businessAreas}
          recurringService={recurringService}
        />
      </Card>
    </div>
  );
}
