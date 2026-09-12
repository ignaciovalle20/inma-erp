import { redirect } from "next/navigation";
import { getSession, getCompanyForEdit, getBusinessAreaForEdit } from "@/lib/dal";
import { EditBusinessAreaForm } from "./form";

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
    <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 px-4 py-10">
      <h1 className="text-xl font-semibold text-black dark:text-zinc-50">
        Edit {area.name}
      </h1>
      <EditBusinessAreaForm companyId={id} area={area} />
    </div>
  );
}
