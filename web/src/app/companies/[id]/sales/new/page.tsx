import { redirect } from "next/navigation";
import { getSession, getCompanyForEdit, getClients } from "@/lib/dal";
import { NewSalesDocumentForm } from "./form";

export default async function NewSalesDocumentPage({
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

  const clients = await getClients(id);
  const activeClients = clients.filter((client) => client.active);

  return (
    <div className="mx-auto flex w-full max-w-lg flex-1 flex-col justify-center gap-6 px-4 py-10">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-black dark:text-zinc-50">
          New sales document
        </h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-500">
          {membership.company.name}
        </p>
      </div>
      {activeClients.length === 0 ? (
        <div className="flex flex-col gap-2 rounded-md border border-zinc-200 bg-zinc-50 p-4 text-sm text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
          <p>You need at least one client before creating a sales document -- add one first.</p>
          <a
            className="font-medium text-black underline dark:text-zinc-50"
            href={`/companies/${id}/clients`}
          >
            Go to Clients
          </a>
        </div>
      ) : (
        <NewSalesDocumentForm
          companyId={id}
          clients={activeClients}
          defaultCurrency={membership.company.currency}
        />
      )}
    </div>
  );
}
