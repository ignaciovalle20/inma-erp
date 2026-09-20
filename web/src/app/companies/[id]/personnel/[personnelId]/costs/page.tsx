import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession, getPersonnelForEdit, getPersonnelCosts } from "@/lib/dal";

export default async function PersonnelCostsPage({
  params,
}: {
  params: Promise<{ id: string; personnelId: string }>;
}) {
  const { id, personnelId } = await params;
  const user = await getSession();

  if (!user) {
    redirect("/login");
  }

  // getPersonnelForEdit doubles as the membership + "person belongs to
  // this company" check here.
  const person = await getPersonnelForEdit(id, personnelId);

  if (!person) {
    redirect(`/companies/${id}/personnel`);
  }

  // External technicians have no monthly cost: their money is per job, in their cuenta corriente.
  if (person.type === "contractor") {
    redirect(`/companies/${id}/personnel/${personnelId}/account`);
  }

  const costs = await getPersonnelCosts(personnelId);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 py-10">
      <div className="flex items-center justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">
            {person.name}&apos;s costs
          </h1>
          <p className="text-sm text-[var(--color-muted)]">
            {person.type === "employee" ? "Employee" : "Partner"}
          </p>
        </div>
        {person.active ? (
          <Link
            href={`/companies/${id}/personnel/${personnelId}/costs/new`}
            className="rounded-full bg-foreground px-5 py-2 text-sm font-medium text-background transition-colors hover:bg-[var(--color-primary-hover)] dark:hover:bg-[var(--color-primary-hover)]"
          >
            Record cost
          </Link>
        ) : null}
      </div>

      {!person.active ? (
        <p className="text-sm text-[var(--color-muted)]">
          This person is inactive -- no new cost records can be added.
        </p>
      ) : null}

      {costs.length === 0 ? (
        <p className="text-zinc-600 dark:text-zinc-400">
          No cost records yet for {person.name}.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {costs.map((cost) => (
            <li
              key={cost.id}
              className="flex items-center justify-between rounded-lg border border-black/[.08] px-4 py-3 dark:border-white/[.145]"
            >
              <span className="font-medium text-black dark:text-zinc-50">
                {cost.period}
              </span>
              <div className="flex items-center gap-4">
                <span className="text-sm text-zinc-600 dark:text-zinc-400">
                  {cost.amount.toLocaleString()} {cost.currency}
                </span>
                <Link
                  href={`/companies/${id}/personnel/${personnelId}/costs/${cost.id}/allocate`}
                  className="text-sm font-medium text-black underline dark:text-zinc-50"
                >
                  Allocate
                </Link>
              </div>
            </li>
          ))}
        </ul>
      )}

      <Link
        href={`/companies/${id}/personnel`}
        className="text-sm text-zinc-600 hover:text-black dark:text-zinc-400 dark:hover:text-zinc-50"
      >
        Back to personnel
      </Link>
    </div>
  );
}
