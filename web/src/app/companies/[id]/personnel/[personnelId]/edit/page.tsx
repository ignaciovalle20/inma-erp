import { redirect } from "next/navigation";
import { getSession, getPersonnelForEdit } from "@/lib/dal";
import { EditPersonnelForm } from "./form";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/Card";

export default async function EditPersonnelPage({
  params,
}: {
  params: Promise<{ id: string; personnelId: string }>;
}) {
  const { id, personnelId } = await params;
  const user = await getSession();

  if (!user) {
    redirect("/login");
  }

  const person = await getPersonnelForEdit(id, personnelId);

  if (!person) {
    redirect(`/companies/${id}/personnel`);
  }

  return (
    <div className="mx-auto flex w-full max-w-[480px] flex-col gap-5">
      <PageHeader eyebrow="MAESTROS / PERSONAL" title={`Editar ${person.name}`} />
      <Card>
        <EditPersonnelForm companyId={id} person={person} />
      </Card>
    </div>
  );
}
