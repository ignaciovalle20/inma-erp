import { redirect } from "next/navigation";
import { getSession, getCompanyForEdit } from "@/lib/dal";
import { NewPersonnelForm } from "./form";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/Card";

export default async function NewPersonnelPage({
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

  return (
    <div className="mx-auto flex w-full max-w-[480px] flex-col gap-5">
      <PageHeader
        eyebrow="MAESTROS / PERSONAL"
        title="Nueva persona"
        subtitle={membership.company.name}
      />
      <Card>
        <NewPersonnelForm companyId={id} />
      </Card>
    </div>
  );
}
