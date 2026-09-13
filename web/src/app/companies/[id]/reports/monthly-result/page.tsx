import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession, getCompanyForEdit } from "@/lib/dal";
import { computeMonthlyResult, monthRange } from "@/lib/reporting";

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

export default async function MonthlyResultReportPage({
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
  // getCompanyForEdit doubles as the membership check here, same
  // pattern as the Projects page.
  const membership = await getCompanyForEdit(id);

  if (!membership) {
    redirect("/companies");
  }

  const period = /^\d{4}-\d{2}$/.test(periodParam ?? "")
    ? (periodParam as string)
    : currentMonth();
  const periodDate = `${period}-01`;

  const result = await computeMonthlyResult(id, periodDate);
  const currency = membership.company.currency;

  // Story 6.4: drill-down links use the exact same [start, end) range
  // the calculation summed over, so the filtered list's sum reconciles
  // with the figure. `voided=exclude` matches netSales' own exclusion
  // of voided sales documents.
  const { start, end } = monthRange(periodDate);
  const salesHref = `/companies/${id}/sales?from=${start}&to=${end}&voided=exclude`;
  const directCostsHref = `/companies/${id}/costs?from=${start}&to=${end}&classification=direct`;
  const generalCostsHref = `/companies/${id}/costs?from=${start}&to=${end}&classification=general`;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 py-10">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">
          Monthly result
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

      {result.pendingProjectCount > 0 ? (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900/60 dark:bg-amber-900/20 dark:text-amber-300">
          {result.pendingProjectCount} project
          {result.pendingProjectCount === 1 ? " has" : "s have"} no cost
          recorded yet -- the confirmed result may decrease once entered.
        </div>
      ) : null}

      <dl className="flex flex-col gap-3 rounded-lg border border-black/[.08] px-4 py-3 dark:border-white/[.145]">
        <div className="flex items-center justify-between">
          <dt className="text-zinc-600 dark:text-zinc-400">
            <Link
              href={salesHref}
              className="underline underline-offset-2 hover:text-black dark:hover:text-zinc-50"
            >
              Net sales
            </Link>
          </dt>
          <dd className="font-medium text-black dark:text-zinc-50">
            {formatAmount(result.netSales, currency)}
          </dd>
        </div>
        <div className="flex items-center justify-between">
          <dt className="text-zinc-600 dark:text-zinc-400">
            <Link
              href={directCostsHref}
              className="underline underline-offset-2 hover:text-black dark:hover:text-zinc-50"
            >
              Direct costs
            </Link>
          </dt>
          <dd className="font-medium text-black dark:text-zinc-50">
            {formatAmount(result.directCosts, currency)}
          </dd>
        </div>
        <div className="flex items-center justify-between border-t border-black/[.08] pt-3 dark:border-white/[.145]">
          <dt className="font-medium text-zinc-700 dark:text-zinc-300">
            Direct margin
          </dt>
          <dd className="font-semibold text-black dark:text-zinc-50">
            {formatAmount(result.directMargin, currency)}
          </dd>
        </div>
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between">
            <dt className="text-zinc-600 dark:text-zinc-400">
              <Link
                href={generalCostsHref}
                className="underline underline-offset-2 hover:text-black dark:hover:text-zinc-50"
              >
                General costs
              </Link>
            </dt>
            <dd className="font-medium text-black dark:text-zinc-50">
              {formatAmount(result.generalCosts, currency)}
            </dd>
          </div>
          <div className="flex items-center justify-between text-xs text-zinc-500 dark:text-zinc-500">
            <dt>of which cost documents</dt>
            <dd>{formatAmount(result.generalCostDocuments, currency)}</dd>
          </div>
          <div className="flex items-center justify-between text-xs text-zinc-500 dark:text-zinc-500">
            <dt>of which personnel</dt>
            <dd>{formatAmount(result.generalPersonnelCosts, currency)}</dd>
          </div>
        </div>
        <div className="flex items-center justify-between border-t border-black/[.08] pt-3 dark:border-white/[.145]">
          <dt className="font-medium text-zinc-700 dark:text-zinc-300">
            Operating result
          </dt>
          <dd className="font-semibold text-black dark:text-zinc-50">
            {formatAmount(result.operatingResult, currency)}
          </dd>
        </div>
      </dl>

      <Link
        href={`/companies/${id}/reports/profitability`}
        className="text-sm text-zinc-600 hover:text-black dark:text-zinc-400 dark:hover:text-zinc-50"
      >
        View profitability by client, project & area
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
