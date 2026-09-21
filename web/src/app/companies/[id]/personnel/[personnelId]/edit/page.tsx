import { redirect } from "next/navigation";
import { getSession, getPersonnelForEdit, getCompanyForEdit } from "@/lib/dal";
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

  const [person, membership] = await Promise.all([
    getPersonnelForEdit(id, personnelId),
    getCompanyForEdit(id),
  ]);

  if (!person || !membership) {
    redirect(`/companies/${id}/personnel`);
  }

  return (
    <div className="mx-auto flex w-full max-w-[480px] flex-col gap-5">
      <PageHeader eyebrow="CONFIGURACIÓN / PERSONAL" title={`Editar ${person.name}`} />
      <Card>
        <EditPersonnelForm companyId={id} person={person} currency={membership.company.currency} />
      </Card>
    </div>
  );
}
