import { redirect } from "next/navigation";
import { getSession, getCompanyForEdit } from "@/lib/dal";
import { EditCompanyForm } from "./form";

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
    <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 px-4 py-10">
      <h1 className="text-xl font-semibold text-black dark:text-zinc-50">
        Edit {result.company.name}
      </h1>
      <EditCompanyForm companyId={result.company.id} company={result.company} />
    </div>
  );
}
