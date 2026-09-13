import { redirect } from "next/navigation";
import { getSession, getCompanyForEdit, getSuppliers, getProjects } from "@/lib/dal";
import { NewCostDocumentForm } from "./form";

export default async function NewCostDocumentPage({
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

  const [suppliers, projects] = await Promise.all([
    getSuppliers(id),
    getProjects(id),
  ]);

  const activeSuppliers = suppliers.filter((supplier) => supplier.active);
  const activeProjects = projects.filter((project) => project.status === "active");

  return (
    <div className="mx-auto flex w-full max-w-lg flex-1 flex-col justify-center gap-6 px-4 py-10">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-black dark:text-zinc-50">
          New cost document
        </h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-500">
          {membership.company.name}
        </p>
      </div>
      <NewCostDocumentForm
        companyId={id}
        suppliers={activeSuppliers}
        projects={activeProjects}
        defaultCurrency={membership.company.currency}
      />
    </div>
  );
}
