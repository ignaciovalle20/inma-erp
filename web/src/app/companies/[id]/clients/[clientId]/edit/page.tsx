import { redirect } from "next/navigation";
import { getSession, getClientForEdit } from "@/lib/dal";
import { EditClientForm } from "./form";

export default async function EditClientPage({
  params,
}: {
  params: Promise<{ id: string; clientId: string }>;
}) {
  const { id, clientId } = await params;
  const user = await getSession();

  if (!user) {
    redirect("/login");
  }

  const client = await getClientForEdit(id, clientId);

  if (!client) {
    redirect(`/companies/${id}/clients`);
  }

  return (
    <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 px-4 py-10">
      <h1 className="text-xl font-semibold text-black dark:text-zinc-50">
        Edit {client.name}
      </h1>
      <EditClientForm companyId={id} client={client} />
    </div>
  );
}
