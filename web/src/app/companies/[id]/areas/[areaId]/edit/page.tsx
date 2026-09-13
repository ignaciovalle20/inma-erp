import { redirect } from "next/navigation";
import { getSession, getCompanyForEdit, getBusinessAreaForEdit } from "@/lib/dal";
import { EditBusinessAreaForm } from "./form";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/Card";

export default async function EditBusinessAreaPage({
  params,
}: {
  params: Promise<{ id: string; areaId: string }>;
}) {
  const { id, areaId } = await params;
  const user = await getSession();

  if (!user) {
    redirect("/login");
  }

  // Editing (rename/deactivate) is admin-only -- unlike clients, a
  // plain member should never reach this form even if they guess the
  // URL, so we gate on role here rather than relying on RLS alone.
  const membership = await getCompanyForEdit(id);

  if (!membership || membership.role !== "admin") {
    redirect(`/companies/${id}/areas`);
  }

  const area = await getBusinessAreaForEdit(id, areaId);

  if (!area) {
    redirect(`/companies/${id}/areas`);
  }

  return (
    <div className="mx-auto flex w-full max-w-[480px] flex-col gap-5">
      <PageHeader eyebrow="MAESTROS / ÁREAS DE NEGOCIO" title={`Editar ${area.name}`} />
      <Card>
        <EditBusinessAreaForm companyId={id} area={area} />
      </Card>
    </div>
  );
}
