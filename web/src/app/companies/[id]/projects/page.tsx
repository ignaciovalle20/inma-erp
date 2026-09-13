import Link from "next/link";
import { redirect } from "next/navigation";
import {
  getSession,
  getCompanyForEdit,
  getProjectCostStatus,
  type ProjectCostStatus,
} from "@/lib/dal";
import { confirmProjectCostZero, removeProjectCostConfirmation } from "./actions";

const STATUS_LABEL: Record<string, string> = {
  active: "Active",
  on_hold: "On hold",
  closed: "Closed",
};

const STATUS_CLASS: Record<string, string> = {
  active:
    "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300",
  on_hold:
    "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  closed: "bg-zinc-200 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
};

const COST_STATUS_LABEL: Record<ProjectCostStatus, string> = {
  has_costs: "Has costs",
  confirmed_zero: "Confirmed zero",
  pending: "Pending",
};

const COST_STATUS_CLASS: Record<ProjectCostStatus, string> = {
  has_costs:
    "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
  confirmed_zero:
    "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300",
  pending:
    "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
};

function currentMonth(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

export default async function ProjectsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ period?: string }>;
}) {
  const { id } = await params;
  const { period: periodParam } = await searchParams;
  const user = await getSession();

  if (!user) {
    redirect("/login");
  }

  // Any membership (any role) is enough to view a company's projects --
  // getCompanyForEdit doubles as the membership check here.
  const membership = await getCompanyForEdit(id);

  if (!membership) {
    redirect("/companies");
  }

  const period = /^\d{4}-\d{2}$/.test(periodParam ?? "")
    ? (periodParam as string)
    : currentMonth();
  const periodDate = `${period}-01`;

  const projects = await getProjectCostStatus(id, periodDate);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 py-10">
      <div className="flex items-center justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">
            Projects
          </h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-500">
            {membership.company.name}
          </p>
        </div>
        <Link
          href={`/companies/${id}/projects/new`}
          className="rounded-full bg-foreground px-5 py-2 text-sm font-medium text-background transition-colors hover:bg-[#383838] dark:hover:bg-[#ccc]"
        >
          New project
        </Link>
      </div>

      <form className="flex items-center gap-2" method="get">
        <label
          htmlFor="period"
          className="text-sm text-zinc-600 dark:text-zinc-400"
        >
          Cost review month
        </label>
        <input
          id="period"
          name="period"
          type="month"
          defaultValue={period}
          className="rounded-md border border-black/[.08] bg-transparent px-2 py-1 text-sm dark:border-white/[.145]"
        />
        <button
          type="submit"
          className="rounded-md border border-black/[.08] px-3 py-1 text-sm font-medium text-zinc-700 hover:bg-zinc-50 dark:border-white/[.145] dark:text-zinc-300 dark:hover:bg-zinc-900"
        >
          Go
        </button>
      </form>

      {projects.length === 0 ? (
        <p className="text-zinc-600 dark:text-zinc-400">
          No active projects for this company.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {projects.map((project) => (
            <li
              key={project.id}
              className="flex items-center justify-between rounded-lg border border-black/[.08] px-4 py-3 dark:border-white/[.145]"
            >
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-black dark:text-zinc-50">
                    {project.name}
                  </span>
                  <span
                    className={
                      "rounded-full px-2 py-0.5 text-xs font-medium " +
                      (STATUS_CLASS[project.status] ?? "")
                    }
                  >
                    {STATUS_LABEL[project.status] ?? project.status}
                  </span>
                  <span
                    className={
                      "rounded-full px-2 py-0.5 text-xs font-medium " +
                      COST_STATUS_CLASS[project.cost_status]
                    }
                  >
                    {COST_STATUS_LABEL[project.cost_status]}
                  </span>
                </div>
                <span className="text-sm text-zinc-500 dark:text-zinc-500">
                  {[
                    project.client_name,
                    project.business_area_name,
                    project.budget != null
                      ? `budget: ${project.budget}`
                      : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </div>
              <div className="flex items-center gap-3">
                {project.cost_status === "pending" ? (
                  <form
                    action={confirmProjectCostZero.bind(
                      null,
                      id,
                      project.id,
                      periodDate,
                    )}
                  >
                    <button
                      type="submit"
                      className="text-sm font-medium text-zinc-700 underline underline-offset-2 hover:text-black dark:text-zinc-300 dark:hover:text-zinc-50"
                    >
                      Confirm zero
                    </button>
                  </form>
                ) : null}
                {project.cost_status === "confirmed_zero" ? (
                  <form
                    action={removeProjectCostConfirmation.bind(
                      null,
                      id,
                      project.id,
                      periodDate,
                    )}
                  >
                    <button
                      type="submit"
                      className="text-sm font-medium text-zinc-700 underline underline-offset-2 hover:text-black dark:text-zinc-300 dark:hover:text-zinc-50"
                    >
                      Remove confirmation
                    </button>
                  </form>
                ) : null}
                <Link
                  href={`/companies/${id}/projects/${project.id}/edit`}
                  className="text-sm font-medium text-zinc-700 underline underline-offset-2 hover:text-black dark:text-zinc-300 dark:hover:text-zinc-50"
                >
                  Edit
                </Link>
              </div>
            </li>
          ))}
        </ul>
      )}

      <Link
        href="/companies"
        className="text-sm text-zinc-600 hover:text-black dark:text-zinc-400 dark:hover:text-zinc-50"
      >
        Back to companies
      </Link>
    </div>
  );
}
