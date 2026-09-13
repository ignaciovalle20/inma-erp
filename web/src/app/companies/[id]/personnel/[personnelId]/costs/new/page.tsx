import { redirect } from "next/navigation";
import {
  getSession,
  getCompanyForEdit,
  getPersonnelForEdit,
} from "@/lib/dal";
import { NewPersonnelCostForm } from "./form";

export default async function NewPersonnelCostPage({
  params,
}: {
  params: Promise<{ id: string; personnelId: string }>;
}) {
  const { id, personnelId } = await params;
  const user = await getSession();

  if (!user) {
    redirect("/login");
  }

  const membership = await getCompanyForEdit(id);

  if (!membership) {
    redirect("/companies");
  }

  const person = await getPersonnelForEdit(id, personnelId);

  if (!person) {
    redirect(`/companies/${id}/personnel`);
  }

  if (!person.active) {
    redirect(`/companies/${id}/personnel/${personnelId}/costs`);
  }

  return (
    <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 px-4 py-10">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-black dark:text-zinc-50">
          Record cost for {person.name}
        </h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-500">
          {membership.company.name}
        </p>
      </div>
      <NewPersonnelCostForm
        companyId={id}
        personnelId={personnelId}
        defaultCurrency={membership.company.currency}
      />
    </div>
  );
}
