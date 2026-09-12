import { redirect } from "next/navigation";
import { getSession, getSupplierForEdit } from "@/lib/dal";
import { EditSupplierForm } from "./form";

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
    <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 px-4 py-10">
      <h1 className="text-xl font-semibold text-black dark:text-zinc-50">
        Edit {supplier.name}
      </h1>
      <EditSupplierForm companyId={id} supplier={supplier} />
    </div>
  );
}
