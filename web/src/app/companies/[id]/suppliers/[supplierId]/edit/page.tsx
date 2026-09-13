import { redirect } from "next/navigation";
import { getSession, getSupplierForEdit } from "@/lib/dal";
import { EditSupplierForm } from "./form";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/Card";

export default async function EditSupplierPage({
  params,
}: {
  params: Promise<{ id: string; supplierId: string }>;
}) {
  const { id, supplierId } = await params;
  const user = await getSession();

  if (!user) {
    redirect("/login");
  }

  const supplier = await getSupplierForEdit(id, supplierId);

  if (!supplier) {
    redirect(`/companies/${id}/suppliers`);
  }

  return (
    <div className="mx-auto flex w-full max-w-[520px] flex-col gap-5">
      <PageHeader eyebrow="MAESTROS / PROVEEDORES" title={`Editar ${supplier.name}`} />
      <Card>
        <EditSupplierForm companyId={id} supplier={supplier} />
      </Card>
    </div>
  );
}
