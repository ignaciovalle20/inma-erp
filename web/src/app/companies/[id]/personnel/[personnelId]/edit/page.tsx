import { redirect } from "next/navigation";
import { getSession, getPersonnelForEdit } from "@/lib/dal";
import { EditPersonnelForm } from "./form";

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

  const person = await getPersonnelForEdit(id, personnelId);

  if (!person) {
    redirect(`/companies/${id}/personnel`);
  }

  return (
    <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 px-4 py-10">
      <h1 className="text-xl font-semibold text-black dark:text-zinc-50">
        Edit {person.name}
      </h1>
      <EditPersonnelForm companyId={id} person={person} />
    </div>
  );
}
