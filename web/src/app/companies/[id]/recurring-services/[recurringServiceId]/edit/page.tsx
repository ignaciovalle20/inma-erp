import { redirect } from "next/navigation";
import { getSession, getRecurringServiceForEdit, getClients } from "@/lib/dal";
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

  const recurringService = await getRecurringServiceForEdit(
    id,
    recurringServiceId,
  );

  if (!recurringService) {
    redirect(`/companies/${id}/recurring-services`);
  }

  const clients = await getClients(id);

  return (
    <div className="mx-auto flex w-full max-w-[560px] flex-col gap-5">
      <PageHeader
        eyebrow="MAESTROS / SERVICIOS RECURRENTES"
        title={`Editar ${recurringService.name}`}
      />
      <Card>
        <EditRecurringServiceForm
          companyId={id}
          clients={clients}
          recurringService={recurringService}
        />
      </Card>
    </div>
  );
}
