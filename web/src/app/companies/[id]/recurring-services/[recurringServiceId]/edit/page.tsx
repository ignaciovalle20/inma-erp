import { redirect } from "next/navigation";
import { getSession, getRecurringServiceForEdit, getClients } from "@/lib/dal";
import { EditRecurringServiceForm } from "./form";

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
    <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 px-4 py-10">
      <h1 className="text-xl font-semibold text-black dark:text-zinc-50">
        Edit {recurringService.name}
      </h1>
      <EditRecurringServiceForm
        companyId={id}
        clients={clients}
        recurringService={recurringService}
      />
    </div>
  );
}
