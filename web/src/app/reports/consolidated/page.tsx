import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/dal";
import { computeConsolidatedResult } from "@/lib/reporting";

function currentMonth(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

function formatUsd(amount: number): string {
  return `${amount.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} USD`;
}

/**
 * Story 6.5: Consolidated Chile + Uruguay Result in USD.
 *
 * Top-level (not company-scoped) report -- includes every company the
 * viewer is a member of, per spec Boundaries. A company whose
 * currency's rate couldn't be resolved shows a "pending exchange rate"
 * notice instead of being silently omitted or shown as zero.
 */
export default async function ConsolidatedReportPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>;
}) {
  const { period: periodParam } = await searchParams;
  const user = await getSession();

  if (!user) {
    redirect("/login");
  }

  const period = /^\d{4}-\d{2}$/.test(periodParam ?? "")
    ? (periodParam as string)
    : currentMonth();
  const periodDate = `${period}-01`;

  const consolidated = await computeConsolidatedResult(periodDate);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 py-10">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">
          Consolidated result (USD)
        </h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-500">
          Every company you belong to, converted to USD and summed
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

      {consolidated.companies.length === 0 ? (
        <p className="text-zinc-600 dark:text-zinc-400">
          You don&apos;t have access to any company yet.
        </p>
      ) : (
        <>
          <dl className="flex flex-col gap-3 rounded-lg border border-black/[.08] px-4 py-3 dark:border-white/[.145]">
            {consolidated.companies.map((company) => (
              <div
                key={company.companyId}
                className="flex flex-col gap-1 border-b border-black/[.08] pb-3 last:border-b-0 last:pb-0 dark:border-white/[.145]"
              >
                <div className="flex items-center justify-between">
                  <dt className="font-medium text-zinc-700 dark:text-zinc-300">
                    {company.companyName}
                  </dt>
                  <dd className="text-sm text-zinc-500 dark:text-zinc-500">
                    {company.result.operatingResult.toLocaleString(undefined, {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}{" "}
                    {company.currency}
                  </dd>
                </div>
                <div className="flex items-center justify-between">
                  <dt className="text-sm text-zinc-500 dark:text-zinc-500">
                    Operating result in USD
                  </dt>
                  <dd className="font-medium text-black dark:text-zinc-50">
                    {company.usdAmount !== null
                      ? formatUsd(company.usdAmount)
                      : "--"}
                  </dd>
                </div>
                {company.ratePending ? (
                  <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/60 dark:bg-amber-900/20 dark:text-amber-300">
                    Pending exchange rate -- couldn&apos;t reach the rate
                    source and no snapshot exists yet for this period.
                  </div>
                ) : null}
              </div>
            ))}
          </dl>

          <dl className="flex items-center justify-between rounded-lg border border-black/[.08] px-4 py-3 dark:border-white/[.145]">
            <dt className="font-medium text-zinc-700 dark:text-zinc-300">
              Total (USD)
            </dt>
            <dd className="text-lg font-semibold text-black dark:text-zinc-50">
              {formatUsd(consolidated.totalUsd)}
            </dd>
          </dl>

          {consolidated.pendingRateCompanies.length > 0 ? (
            <p className="text-xs text-zinc-500 dark:text-zinc-500">
              Total excludes{" "}
              {consolidated.pendingRateCompanies
                .map((company) => company.companyName)
                .join(", ")}{" "}
              -- pending exchange rate, not counted as zero.
            </p>
          ) : null}
        </>
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
