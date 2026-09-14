import { redirect } from "next/navigation";
import { getSession, getClientForEdit } from "@/lib/dal";
import { EditClientForm } from "./form";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/Card";

export default async function EditClientPage({
  params,
}: {
  params: Promise<{ id: string; clientId: string }>;
}) {
  const { id, clientId } = await params;
  const user = await getSession();

  if (!user) {
    redirect("/login");
  }

  const client = await getClientForEdit(id, clientId);

  if (!client) {
    redirect(`/companies/${id}/clients`);
  }

  return (
    <div className="mx-auto flex w-full max-w-[520px] flex-col gap-5">
      <PageHeader eyebrow="CONFIGURACIÓN / CLIENTES" title={`Editar ${client.name}`} />
      <Card>
        <EditClientForm companyId={id} client={client} />
      </Card>
    </div>
  );
}
