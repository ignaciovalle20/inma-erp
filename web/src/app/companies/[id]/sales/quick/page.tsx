import { redirect } from "next/navigation";
import {
  getSession,
  getCompanyForEdit,
  getClients,
  getBusinessAreas,
} from "@/lib/dal";
import { QuickSalesEntryForm } from "./form";

export default async function QuickSalesEntryPage({
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

  // Quick entry only exists for Uruguay companies (currency === 'UYU'
  // is the reliable enum-constrained signal, per the spec's Decisions)
  // -- direct navigation for any other company falls back to the full
  // form, which stays available for every company regardless.
  if (membership.company.currency !== "UYU") {
    redirect(`/companies/${id}/sales/new`);
  }

  const [clients, businessAreas] = await Promise.all([
    getClients(id),
    getBusinessAreas(id),
  ]);

  const activeClients = clients.filter((client) => client.active);
  const activeBusinessAreas = businessAreas.filter((area) => area.active);

  return (
    <div className="mx-auto flex w-full max-w-lg flex-1 flex-col justify-center gap-6 px-4 py-10">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-black dark:text-zinc-50">
          Quick entry
        </h1>
        <p className="text-sm text-[var(--color-muted)]">
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
      ) : activeBusinessAreas.length === 0 ? (
        <div className="flex flex-col gap-2 rounded-md border border-zinc-200 bg-zinc-50 p-4 text-sm text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
          <p>You need at least one active business area before creating a sales document -- add one first.</p>
          <a
            className="font-medium text-black underline dark:text-zinc-50"
            href={`/companies/${id}/areas`}
          >
            Go to Business Areas
          </a>
        </div>
      ) : (
        <QuickSalesEntryForm
          companyId={id}
          clients={activeClients}
          businessAreas={activeBusinessAreas}
        />
      )}
    </div>
  );
}
