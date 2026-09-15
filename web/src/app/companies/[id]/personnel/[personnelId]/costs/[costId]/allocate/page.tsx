import { redirect } from "next/navigation";
import {
  getSession,
  getCompanyForEdit,
  getPersonnelForEdit,
  getPersonnelCostForEdit,
  getWorkAllocations,
  getWorkAllocationRemainder,
  getProjects,
} from "@/lib/dal";
import { WorkAllocationForm, RemoveAllocationButton } from "./form";

export default async function AllocateWorkPage({
  params,
}: {
  params: Promise<{ id: string; personnelId: string; costId: string }>;
}) {
  const { id, personnelId, costId } = await params;
  const user = await getSession();

  if (!user) {
    redirect("/login");
  }

  const membership = await getCompanyForEdit(id);

  if (!membership) {
    redirect("/companies");
  }

  const [person, cost] = await Promise.all([
    getPersonnelForEdit(id, personnelId),
    getPersonnelCostForEdit(id, personnelId, costId),
  ]);

  if (!person) {
    redirect(`/companies/${id}/personnel`);
  }

  if (!cost) {
    redirect(`/companies/${id}/personnel/${personnelId}/costs`);
  }

  const [allocations, projects] = await Promise.all([
    getWorkAllocations(costId),
    getProjects(id),
  ]);

  const activeProjects = projects.filter((project) => project.status !== "closed");
  const remainder = getWorkAllocationRemainder(cost.amount, allocations);

  return (
    <div className="mx-auto flex w-full max-w-lg flex-1 flex-col gap-6 px-4 py-10">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-black dark:text-zinc-50">
          Allocate {person.name}&apos;s cost
        </h1>
        <p className="text-sm text-[var(--color-muted)]">
          {cost.period} &middot; {cost.amount.toLocaleString()} {cost.currency}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 rounded-lg border border-black/[.08] p-4 dark:border-white/[.145]">
        <div className="flex flex-col gap-1">
          <span className="text-xs uppercase text-[var(--color-muted)]">
            Total amount
          </span>
          <span className="font-medium text-black dark:text-zinc-50">
            {cost.amount.toLocaleString()} {cost.currency}
          </span>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs uppercase text-[var(--color-muted)]">
            Unallocated remainder
          </span>
          <span
            className="font-medium text-black dark:text-zinc-50"
            data-testid="remainder"
          >
            {remainder.toLocaleString()} {cost.currency}
          </span>
        </div>
      </div>

      {allocations.length === 0 ? (
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          No allocations yet -- the full amount is unassigned labor cost.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {allocations.map((allocation) => (
            <li
              key={allocation.id}
              className="flex items-center justify-between rounded-lg border border-black/[.08] px-4 py-3 dark:border-white/[.145]"
            >
              <div className="flex flex-col">
                <span className="font-medium text-black dark:text-zinc-50">
                  {allocation.project_name ?? "Unknown project"}
                </span>
                <span className="text-sm text-[var(--color-muted)]">
                  {allocation.amount.toLocaleString()} {cost.currency}
                  {allocation.hours !== null
                    ? ` · ${allocation.hours} hrs`
                    : ""}
                </span>
              </div>
              <RemoveAllocationButton
                companyId={id}
                personnelId={personnelId}
                costId={costId}
                allocationId={allocation.id}
              />
            </li>
          ))}
        </ul>
      )}

      <WorkAllocationForm
        companyId={id}
        personnelId={personnelId}
        costId={costId}
        projects={activeProjects}
        remainder={remainder}
        currency={cost.currency}
      />

      <a
        href={`/companies/${id}/personnel/${personnelId}/costs`}
        className="text-sm text-zinc-600 hover:text-black dark:text-zinc-400 dark:hover:text-zinc-50"
      >
        Back to costs
      </a>
    </div>
  );
}

