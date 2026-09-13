import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession, getCompanyForEdit } from "@/lib/dal";
import { getProfitabilityBreakdown } from "@/lib/reporting";

function currentMonth(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

function formatAmount(amount: number, currency: string): string {
  return `${amount.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ${currency}`;
}

export default async function ProfitabilityReportPage({
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

  // Any membership (any role) is enough to view a company's reports --
  // same pattern as the Monthly Result report.
  const membership = await getCompanyForEdit(id);

  if (!membership) {
    redirect("/companies");
  }

  const period = /^\d{4}-\d{2}$/.test(periodParam ?? "")
    ? (periodParam as string)
    : currentMonth();
  const periodDate = `${period}-01`;

  const breakdown = await getProfitabilityBreakdown(id, periodDate);
  const currency = membership.company.currency;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 py-10">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">
          Profitability by client, project & area
        </h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-500">
          {membership.company.name}
        </p>
      </div>

      <form className="flex items-center gap-2" method="get">
        <label
          htmlFor="period"
          className="text-sm text-zinc-600 dark:text-zinc-400"
        >
          Month
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

      <ProfitabilitySection
        title="By client"
        currency={currency}
        rows={breakdown.clients}
        emptyMessage="No clients yet."
      />

      <div className="flex flex-col gap-2">
        <h2 className="text-lg font-medium text-black dark:text-zinc-50">
          By project
        </h2>
        {breakdown.projects.length === 0 ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-500">
            No projects yet.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-black/[.08] dark:border-white/[.145]">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-black/[.08] text-left text-zinc-500 dark:border-white/[.145] dark:text-zinc-500">
                  <th className="px-3 py-2 font-medium">Project</th>
                  <th className="px-3 py-2 font-medium">Client</th>
                  <th className="px-3 py-2 text-right font-medium">
                    Revenue (period)
                  </th>
                  <th className="px-3 py-2 text-right font-medium">
                    Costs (period)
                  </th>
                  <th className="px-3 py-2 text-right font-medium">
                    Margin (period)
                  </th>
                  <th className="px-3 py-2 text-right font-medium">
                    Margin (accumulated)
                  </th>
                </tr>
              </thead>
              <tbody>
                {breakdown.projects.map((project) => (
                  <tr
                    key={project.id}
                    className="border-b border-black/[.04] last:border-0 dark:border-white/[.06]"
                  >
                    <td className="px-3 py-2 text-black dark:text-zinc-50">
                      {project.name}
                    </td>
                    <td className="px-3 py-2 text-zinc-600 dark:text-zinc-400">
                      {project.clientName ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-right text-black dark:text-zinc-50">
                      {formatAmount(project.revenue, currency)}
                    </td>
                    <td className="px-3 py-2 text-right text-black dark:text-zinc-50">
                      {formatAmount(project.costs, currency)}
                    </td>
                    <td className="px-3 py-2 text-right font-medium text-black dark:text-zinc-50">
                      {formatAmount(project.margin, currency)}
                    </td>
                    <td className="px-3 py-2 text-right font-medium text-black dark:text-zinc-50">
                      {formatAmount(project.accumulatedMargin, currency)}
                      <span className="block text-xs font-normal text-zinc-500 dark:text-zinc-500">
                        rev {formatAmount(project.accumulatedRevenue, currency)}{" "}
                        / costs{" "}
                        {formatAmount(project.accumulatedCosts, currency)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <ProfitabilitySection
        title="By area"
        currency={currency}
        rows={breakdown.areas}
        emptyMessage="No business areas yet."
      />

      <Link
        href={`/companies/${id}/reports/monthly-result`}
        className="text-sm text-zinc-600 hover:text-black dark:text-zinc-400 dark:hover:text-zinc-50"
      >
        View monthly result report
      </Link>
      <Link
        href="/companies"
        className="text-sm text-zinc-600 hover:text-black dark:text-zinc-400 dark:hover:text-zinc-50"
      >
        Back to companies
      </Link>
    </div>
  );
}

function ProfitabilitySection({
  title,
  currency,
  rows,
  emptyMessage,
}: {
  title: string;
  currency: string;
  rows: { id: string; name: string; revenue: number; costs: number; margin: number }[];
  emptyMessage: string;
}) {
  return (
    <div className="flex flex-col gap-2">
      <h2 className="text-lg font-medium text-black dark:text-zinc-50">
        {title}
      </h2>
      {rows.length === 0 ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-500">
          {emptyMessage}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-black/[.08] dark:border-white/[.145]">
          <table className="w-full min-w-[480px] text-sm">
            <thead>
              <tr className="border-b border-black/[.08] text-left text-zinc-500 dark:border-white/[.145] dark:text-zinc-500">
                <th className="px-3 py-2 font-medium">Name</th>
                <th className="px-3 py-2 text-right font-medium">Revenue</th>
                <th className="px-3 py-2 text-right font-medium">Costs</th>
                <th className="px-3 py-2 text-right font-medium">Margin</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.id}
                  className="border-b border-black/[.04] last:border-0 dark:border-white/[.06]"
                >
                  <td className="px-3 py-2 text-black dark:text-zinc-50">
                    {row.name}
                  </td>
                  <td className="px-3 py-2 text-right text-black dark:text-zinc-50">
                    {formatAmount(row.revenue, currency)}
                  </td>
                  <td className="px-3 py-2 text-right text-black dark:text-zinc-50">
                    {formatAmount(row.costs, currency)}
                  </td>
                  <td className="px-3 py-2 text-right font-medium text-black dark:text-zinc-50">
                    {formatAmount(row.margin, currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
