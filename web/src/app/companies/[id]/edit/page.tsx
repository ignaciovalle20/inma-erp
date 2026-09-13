import { redirect } from "next/navigation";
import { getSession, getCompanyForEdit } from "@/lib/dal";
import { EditCompanyForm } from "./form";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/Card";

export default async function EditCompanyPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await getSession();

  if (!user) {
    redirect("/login");
  }

  const result = await getCompanyForEdit(id);

  if (!result || result.role !== "admin") {
    redirect("/companies");
  }

  return (
    <div className="mx-auto flex w-full max-w-[480px] flex-col gap-5">
      <PageHeader eyebrow="ADMINISTRACIÓN" title={`Editar ${result.company.name}`} />
      <Card>
        <EditCompanyForm companyId={result.company.id} company={result.company} />
      </Card>
    </div>
  );
}
