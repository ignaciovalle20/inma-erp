import { createClient } from "@/lib/supabase/server";
import {
  getProjectCostStatus,
  getClients,
  getProjects,
  getBusinessAreas,
  getUserCompanies,
  getSession,
} from "@/lib/dal";
import {
  getConversionRate,
  getOrSnapshotRate,
  type ReportCurrency,
} from "@/lib/exchangeRates";
import { selectAll } from "@/lib/pagination";

/**
 * Story 6.1: Monthly Result Report -- the shared calculation engine
 * Epic 6's later reports (6.2 especially) will also call. Computes a
 * single company's net sales, direct margin, and operating result for
 * one calendar month, purely from underlying documents -- never a
 * manually entered figure.
 *
 * All figures use `net_amount` (tax-excluded) on both sides --
 * recoverable VAT is never profit or expense, in this or any other
 * report in this file (see `getProfitabilityBreakdown`'s `toNetShare`
 * for how `cost_allocations`, which are recorded against total_amount
 * by SQL invariant, get converted to this same basis). A voided sales
 * document is excluded entirely; a `credit_note` is included but
 * subtracted, via `signedSalesAmount` -- `net_amount` itself is always
 * stored positive regardless of document_type. Direct costs are
 * `cost_documents` where `classification = 'direct'`; general costs
 * are `cost_documents` where `classification = 'general'` (summed by
 * total net_amount, not broken down by `cost_allocations` target --
 * that's Story 6.2's concern) plus the period's total
 * `personnel_costs.amount` (allocated or not -- at company level the
 * money is spent either way).
 *
 * `period` must be the first day of the month (e.g. "2026-09-01"),
 * matching `getProjectCostStatus`'s own convention and
 * `personnel_costs.period`'s check constraint.
 *
 * Mixed-currency documents within one company are out of scope (see
 * spec Decisions) -- every figure here is a plain sum in the company's
 * own currency, no conversion.
 */
/**
 * Story 6.6: a document's *effective* period for reporting is
 * `recognized_period` when a user has explicitly reassigned it, else
 * (the default, unchanged case) its own `document_date`'s month. Every
 * report figure (6.1-6.4) must use this consistently, or a reassigned
 * document would move in some reports but not others.
 *
 * Returns a PostgREST `.or()` filter string expressing that as a single
 * OR of two mutually exclusive cases:
 *   - `recognized_period` is null AND `document_date` falls in [start, end)
 *   - `recognized_period` itself falls in [start, end)
 * `start`/`end` are an inclusive/exclusive month range (see monthRange).
 * Pass `{ foreignTable: "cost_documents" }` as this filter's third
 * `.or()` argument when the query embeds `cost_documents` (e.g. via
 * `cost_allocations!inner`) rather than querying it directly.
 */
function effectivePeriodFilter(start: string, end: string): string {
  return (
    `and(recognized_period.is.null,document_date.gte.${start},document_date.lt.${end}),` +
    `and(recognized_period.gte.${start},recognized_period.lt.${end})`
  );
}

/**
 * H03 fix: `create_sales_document` rejects zero/negative line amounts
 * for every document_type (see the epic2/story1 review patch), so
 * `net_amount` is always stored positive -- a credit_note's amount
 * must be subtracted here at read time, or it inflates sales instead
 * of reducing them. Every other document_type (invoice, receipt,
 * manual) adds as before.
 */
function signedSalesAmount(row: {
  net_amount: number | string | null;
  document_type: string;
}): number {
  const amount = Number(row.net_amount ?? 0);
  return row.document_type === "credit_note" ? -amount : amount;
}

const REPORT_CURRENCIES: ReportCurrency[] = ["CLP", "UYU", "USD"];

/**
 * H02 fix: nothing ties a sales/cost/personnel document's own currency
 * to its company's -- a CLP company can carry a USD sale, and every
 * report here previously summed raw amounts across currencies as if
 * they were the same unit. Resolves, once per report call (not once
 * per row), the rate to convert each of the three possible currencies
 * into `companyCurrency` for `period` -- 1 for companyCurrency itself,
 * no lookup. Scoped to *period* figures only: a row's effective period
 * (recognized_period ?? document_date's month) is always this single
 * `period` here, so one rate per currency is enough. Accumulated
 * project figures (unbounded history, one row per arbitrary past
 * month) are a separate, still-open problem -- see H11's note by
 * `accumulatedRevenueByProject` -- and are deliberately left
 * unconverted for now rather than bolted onto a redesign they don't
 * yet have.
 */
async function resolveCurrencyRates(
  companyCurrency: string,
  period: string,
): Promise<Partial<Record<ReportCurrency, number | null>>> {
  const entries = await Promise.all(
    REPORT_CURRENCIES.map(async (currency) => [
      currency,
      currency === companyCurrency
        ? 1
        : await getConversionRate(currency, companyCurrency as ReportCurrency, period),
    ] as const),
  );
  return Object.fromEntries(entries);
}

/**
 * Converts `amount` (already net/signed as appropriate) from
 * `rowCurrency` into the company's own currency using the rates
 * `resolveCurrencyRates` resolved. `pending: true` means that
 * currency's rate couldn't be resolved for this period -- the amount
 * is excluded (not zeroed) from every sum, and the caller must surface
 * the total as incomplete rather than silently underreporting it as a
 * legitimate lower figure.
 */
function convertToCompanyCurrency(
  amount: number,
  rowCurrency: string,
  rates: Partial<Record<ReportCurrency, number | null>>,
): { amount: number; pending: boolean } {
  const rate = rates[rowCurrency as ReportCurrency];
  if (rate === null || rate === undefined) {
    return { amount: 0, pending: true };
  }
  return { amount: amount * rate, pending: false };
}

/**
 * The readable text of a failed query (the Supabase client hands back an
 * object with .message; anything else is turned into text as it is).
 */
function errorText(error: unknown): string {
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

/**
 * The failed queries of a report as lines a person can read ("las ventas:
 * <message>"), and each one logged for the server. A report used to log the
 * error and add up whatever came back: the screen showed a normal-looking
 * figure with nothing saying part of it was missing (docs/plan-sistema-v3.md, B5).
 */
function failedQueries(queries: Record<string, unknown>): string[] {
  const lines: string[] = [];
  for (const [label, error] of Object.entries(queries)) {
    if (!error) continue;
    console.error(error);
    lines.push(`${label}: ${errorText(error)}`);
  }
  return lines;
}

export type MonthlyResult = {
  netSales: number;
  directCosts: number;
  directMargin: number;
  generalCosts: number;
  // Story 6.4: generalCosts' own two components, broken out for the
  // drill-down link -- generalCosts blends cost_documents
  // (classification='general', linkable to a filtered cost list) with
  // personnel_costs (not linkable to an aggregate list, see spec
  // Decisions). generalCostDocuments + generalPersonnelCosts ===
  // generalCosts always; this never changes the totals, only exposes
  // the split that already existed inside the calculation.
  generalCostDocuments: number;
  generalPersonnelCosts: number;
  operatingResult: number;
  pendingProjectCount: number;
  /**
   * true when at least one of the underlying queries returned an error
   * (network, RLS, timeout, ...). The figures above still sum whatever
   * rows *did* come back -- never a guess -- so a `true` here means the
   * total may be understated, not that it is necessarily wrong. Never
   * infer this from the figures being zero; a legitimately empty month
   * also produces zero and must NOT set this flag.
   */
  hasError: boolean;
  /** What failed, in words, when hasError is true (shown by the screen, not only "something failed"). */
  errors?: string[];
  /**
   * H02 fix: true when a sales/cost/personnel document carried a
   * currency other than the company's own and no conversion rate could
   * be resolved for this period -- that document's amount was excluded
   * (not zeroed) from every figure above, so they may be understated.
   * Never inferred from the figures themselves; a legitimately
   * currency-uniform, fully-resolved month also looks like `false`.
   */
  currencyConversionPending: boolean;
};

export async function computeMonthlyResult(
  companyId: string,
  period: string,
): Promise<MonthlyResult> {
  const user = await getSession();

  const zero: MonthlyResult = {
    netSales: 0,
    directCosts: 0,
    directMargin: 0,
    generalCosts: 0,
    generalCostDocuments: 0,
    generalPersonnelCosts: 0,
    operatingResult: 0,
    pendingProjectCount: 0,
    hasError: false,
    currencyConversionPending: false,
  };

  if (!user) {
    return zero;
  }

  const supabase = await createClient();

  const periodDate = new Date(period);
  const monthStart = new Date(
    Date.UTC(periodDate.getUTCFullYear(), periodDate.getUTCMonth(), 1),
  );
  const monthEnd = new Date(
    Date.UTC(periodDate.getUTCFullYear(), periodDate.getUTCMonth() + 1, 1),
  );
  const monthStartStr = monthStart.toISOString().slice(0, 10);
  const monthEndStr = monthEnd.toISOString().slice(0, 10);

  let projectStatusError: unknown = null;

  const [
    { data: companyRow, error: companyError },
    { data: salesRows, error: salesError },
    { data: costRows, error: costError },
    { data: personnelIdRows, error: personnelIdError },
    projectsWithStatus,
  ] = await Promise.all([
    supabase.from("companies").select("currency").eq("id", companyId).maybeSingle(),
    selectAll(supabase
      .from("sales_documents")
      .select("net_amount, document_type, currency, recognized_period")
      .eq("company_id", companyId)
      .eq("voided", false)
      .or(effectivePeriodFilter(monthStartStr, monthEndStr))),
    selectAll(supabase
      .from("cost_documents")
      .select("net_amount, classification, currency, recognized_period")
      .eq("company_id", companyId)
      .or(effectivePeriodFilter(monthStartStr, monthEndStr))),
    supabase.from("personnel").select("id").eq("company_id", companyId),
    getProjectCostStatus(companyId, monthStartStr).catch((error: unknown) => {
      projectStatusError = error;
      return [];
    }),
  ]);

  // Falls back to a currency no company can actually have (the check
  // constraint only allows CLP/UYU/USD) only if the company row itself
  // couldn't be read -- RLS/membership already guarantee it exists for
  // every real caller, so this path is unreachable in practice; it
  // just avoids treating every document as "same currency" by guessing.
  const companyCurrency = (companyRow?.currency ?? "?") as string;

  const personnelIds = (personnelIdRows ?? []).map((row) => row.id);

  let personnelRows: { amount: number | string; currency: string }[] = [];
  let personnelError: unknown = null;
  if (personnelIds.length > 0) {
    const { data, error } = await selectAll(supabase
      .from("personnel_costs")
      .select("amount, currency")
      .in("personnel_id", personnelIds)
      .eq("period", monthStartStr));

    // Reported with the rest below (failedQueries logs it and puts it on screen).
    personnelError = error;
    personnelRows = data ?? [];
  }

  const errors = failedQueries({
    "la empresa": companyError,
    "las ventas": salesError,
    "los costos": costError,
    "el personal": personnelIdError,
    "el costo del personal": personnelError,
    "el estado de costo de los proyectos": projectStatusError,
  });
  const hasError = errors.length > 0;

  const rates = await resolveCurrencyRates(companyCurrency, monthStartStr);
  let currencyConversionPending = false;
  const convert = (amount: number, currency: string): number => {
    const { amount: converted, pending } = convertToCompanyCurrency(
      amount,
      currency,
      rates,
    );
    if (pending) currencyConversionPending = true;
    return converted;
  };

  const netSales = (salesRows ?? []).reduce(
    (sum, row) => sum + convert(signedSalesAmount(row), row.currency),
    0,
  );

  const directCosts = (costRows ?? [])
    .filter((row) => row.classification === "direct")
    .reduce((sum, row) => sum + convert(Number(row.net_amount ?? 0), row.currency), 0);

  const generalCostDocuments = (costRows ?? [])
    .filter((row) => row.classification === "general")
    .reduce((sum, row) => sum + convert(Number(row.net_amount ?? 0), row.currency), 0);

  const personnelCosts = personnelRows.reduce(
    (sum, row) => sum + convert(Number(row.amount ?? 0), row.currency),
    0,
  );

  const generalCosts = generalCostDocuments + personnelCosts;
  const directMargin = netSales - directCosts;
  const operatingResult = directMargin - generalCosts;

  const pendingProjectCount = projectsWithStatus.filter(
    (project) => project.cost_status === "pending",
  ).length;

  return {
    netSales,
    directCosts,
    directMargin,
    generalCosts,
    generalCostDocuments,
    generalPersonnelCosts: personnelCosts,
    operatingResult,
    pendingProjectCount,
    hasError,
    errors,
    currencyConversionPending,
  };
}

/**
 * Redesign helper: last `months` calendar months of computeMonthlyResult,
 * oldest first, ending at `period`. Same math as computeMonthlyResult
 * (used for a single month elsewhere, e.g. the consolidated report),
 * but fetches each underlying table once for the whole range and
 * buckets rows by month in memory, instead of re-querying per month --
 * calling computeMonthlyResult `months` times fanned out into
 * `months` x ~5 round trips (plus computeMonthlyResult's own nested
 * getProjectCostStatus call, itself 2 more) for the dashboard's
 * 12-month chart alone.
 */
export type MonthlySeriesPoint = MonthlyResult & { period: string };

/** First-of-month UTC key ("YYYY-MM-01") for an arbitrary date string. */
function monthKey(dateStr: string): string {
  const d = new Date(dateStr);
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1),
  ).toISOString().slice(0, 10);
}

export async function getMonthlySeries(
  companyId: string,
  period: string,
  months = 12,
): Promise<MonthlySeriesPoint[]> {
  const user = await getSession();

  const periodDate = new Date(period);
  const periods: string[] = [];
  for (let i = months - 1; i >= 0; i -= 1) {
    const d = new Date(
      Date.UTC(periodDate.getUTCFullYear(), periodDate.getUTCMonth() - i, 1),
    );
    periods.push(d.toISOString().slice(0, 10));
  }

  const zero: MonthlyResult = {
    netSales: 0,
    directCosts: 0,
    directMargin: 0,
    generalCosts: 0,
    generalCostDocuments: 0,
    generalPersonnelCosts: 0,
    operatingResult: 0,
    pendingProjectCount: 0,
    hasError: false,
    currencyConversionPending: false,
  };

  if (!user) {
    return periods.map((p) => ({ period: p, ...zero }));
  }

  const rangeStart = periods[0];
  const rangeEnd = new Date(
    Date.UTC(periodDate.getUTCFullYear(), periodDate.getUTCMonth() + 1, 1),
  )
    .toISOString()
    .slice(0, 10);

  const supabase = await createClient();

  // Wave 1: everything that only needs companyId -- including
  // getProjects, which wave 2's project-status queries need resolved
  // first (activeProjectIds), but which doesn't itself depend on
  // anything below. Firing it alongside these (instead of awaiting it
  // on its own beforehand) turns what was 3 sequential network round
  // trips into 2. personnel_costs is joined straight to personnel here
  // (personnel!inner(company_id)) instead of a separate "get personnel
  // ids for this company" query feeding an `.in(...)` filter -- same
  // rows, one fewer round trip.
  const [
    { data: companyRow, error: companyError },
    { data: salesRows, error: salesError },
    { data: costRows, error: costError },
    { data: personnelRows, error: personnelError },
    projects,
  ] = await Promise.all([
    supabase.from("companies").select("currency").eq("id", companyId).maybeSingle(),
    selectAll(supabase
      .from("sales_documents")
      .select("net_amount, document_type, currency, document_date, recognized_period")
      .eq("company_id", companyId)
      .eq("voided", false)
      .or(effectivePeriodFilter(rangeStart, rangeEnd))),
    selectAll(supabase
      .from("cost_documents")
      .select("net_amount, classification, currency, document_date, recognized_period")
      .eq("company_id", companyId)
      .or(effectivePeriodFilter(rangeStart, rangeEnd))),
    selectAll(supabase
      .from("personnel_costs")
      .select("amount, currency, period, personnel!inner(company_id)")
      .eq("personnel.company_id", companyId)
      .gte("period", rangeStart)
      .lt("period", rangeEnd)),
    getProjects(companyId),
  ]);


  // See computeMonthlyResult's identical comment: unreachable for any
  // real caller (RLS/membership already guarantee the row exists).
  const companyCurrency = (companyRow?.currency ?? "?") as string;

  // "active" -> "en_ejecucion" (direct migration, docs/cambios-flujo-v2.md 4.1).
  const activeProjects = projects.filter((project) => project.status === "en_ejecucion");
  const activeProjectIds = activeProjects.map((project) => project.id);

  const [
    { data: costDateRows, error: costDateError },
    { data: confirmationRows, error: confirmationError },
  ] = await Promise.all([
    activeProjectIds.length > 0
      ? selectAll(supabase
          .from("cost_documents")
          .select("project_id, document_date")
          .in("project_id", activeProjectIds)
          .gte("document_date", rangeStart)
          .lt("document_date", rangeEnd))
      : Promise.resolve({ data: [], error: null }),
    activeProjectIds.length > 0
      ? supabase
          .from("project_cost_confirmations")
          .select("project_id, period")
          .in("project_id", activeProjectIds)
          .gte("period", rangeStart)
          .lt("period", rangeEnd)
      : Promise.resolve({ data: [], error: null }),
  ]);


  // These 5 queries are each fetched once for the whole range, then
  // bucketed by month in memory (see this function's own doc comment)
  // -- a failure in any one of them taints every month it could have
  // contributed rows to, so every returned point carries the same flag
  // rather than trying to guess which specific months were affected.
  const errors = failedQueries({
    "la empresa": companyError,
    "las ventas": salesError,
    "los costos": costError,
    "el costo del personal": personnelError,
    "las fechas de costo de los proyectos": costDateError,
    "las confirmaciones de costo cero": confirmationError,
  });
  const hasError = errors.length > 0;

  // H02 fix: unlike computeMonthlyResult (one fixed period), each row
  // here can land in any of the `months` buckets -- so the conversion
  // rate needed depends on the row's OWN effective month, not the
  // series' end period. Collect (currency, monthKey) amounts first,
  // resolve a rate only for the distinct pairs actually present (never
  // blindly all 3 currencies x months), then convert on a second pass.
  type BucketedAmount = { key: string; currency: string; amount: number };

  const salesAmounts: BucketedAmount[] = (salesRows ?? []).map((row) => ({
    key: monthKey(row.recognized_period ?? row.document_date),
    currency: row.currency,
    amount: signedSalesAmount(row),
  }));

  const directCostAmounts: BucketedAmount[] = [];
  const generalCostDocAmounts: BucketedAmount[] = [];
  for (const row of costRows ?? []) {
    const bucket: BucketedAmount = {
      key: monthKey(row.recognized_period ?? row.document_date),
      currency: row.currency,
      amount: Number(row.net_amount ?? 0),
    };
    (row.classification === "direct" ? directCostAmounts : generalCostDocAmounts).push(
      bucket,
    );
  }

  const personnelAmounts: BucketedAmount[] = (personnelRows ?? []).map((row) => ({
    key: row.period,
    currency: row.currency,
    amount: Number(row.amount ?? 0),
  }));

  const allAmounts = [
    ...salesAmounts,
    ...directCostAmounts,
    ...generalCostDocAmounts,
    ...personnelAmounts,
  ];
  const distinctPairs = new Set(
    allAmounts
      .filter((a) => a.currency !== companyCurrency)
      .map((a) => `${a.currency}:${a.key}`),
  );
  const rateCache = new Map<string, number | null>();
  await Promise.all(
    [...distinctPairs].map(async (pairKey) => {
      const [currency, periodKey] = pairKey.split(":");
      rateCache.set(
        pairKey,
        await getConversionRate(
          currency as ReportCurrency,
          companyCurrency as ReportCurrency,
          periodKey,
        ),
      );
    }),
  );

  const pendingMonths = new Set<string>();
  const convertBucketed = ({ currency, key, amount }: BucketedAmount): number => {
    if (currency === companyCurrency) return amount;
    const rate = rateCache.get(`${currency}:${key}`);
    if (rate === null || rate === undefined) {
      pendingMonths.add(key);
      return 0;
    }
    return amount * rate;
  };

  const netSalesByMonth = new Map<string, number>();
  for (const a of salesAmounts) {
    netSalesByMonth.set(a.key, (netSalesByMonth.get(a.key) ?? 0) + convertBucketed(a));
  }

  const directCostsByMonth = new Map<string, number>();
  for (const a of directCostAmounts) {
    directCostsByMonth.set(
      a.key,
      (directCostsByMonth.get(a.key) ?? 0) + convertBucketed(a),
    );
  }

  const generalCostDocsByMonth = new Map<string, number>();
  for (const a of generalCostDocAmounts) {
    generalCostDocsByMonth.set(
      a.key,
      (generalCostDocsByMonth.get(a.key) ?? 0) + convertBucketed(a),
    );
  }

  const personnelCostsByMonth = new Map<string, number>();
  for (const a of personnelAmounts) {
    personnelCostsByMonth.set(
      a.key,
      (personnelCostsByMonth.get(a.key) ?? 0) + convertBucketed(a),
    );
  }

  const projectsWithCostsByMonth = new Map<string, Set<string>>();
  for (const row of costDateRows ?? []) {
    if (!row.project_id) continue;
    const key = monthKey(row.document_date);
    if (!projectsWithCostsByMonth.has(key)) {
      projectsWithCostsByMonth.set(key, new Set());
    }
    projectsWithCostsByMonth.get(key)!.add(row.project_id);
  }

  const confirmedZeroByMonth = new Map<string, Set<string>>();
  for (const row of confirmationRows ?? []) {
    if (!row.project_id) continue;
    if (!confirmedZeroByMonth.has(row.period)) {
      confirmedZeroByMonth.set(row.period, new Set());
    }
    confirmedZeroByMonth.get(row.period)!.add(row.project_id);
  }

  return periods.map((p) => {
    const netSales = netSalesByMonth.get(p) ?? 0;
    const directCosts = directCostsByMonth.get(p) ?? 0;
    const generalCostDocuments = generalCostDocsByMonth.get(p) ?? 0;
    const generalPersonnelCosts = personnelCostsByMonth.get(p) ?? 0;
    const generalCosts = generalCostDocuments + generalPersonnelCosts;
    const directMargin = netSales - directCosts;
    const operatingResult = directMargin - generalCosts;

    const withCosts = projectsWithCostsByMonth.get(p);
    const confirmedZero = confirmedZeroByMonth.get(p);
    const pendingProjectCount = activeProjects.filter((project) => {
      if (withCosts?.has(project.id)) return false;
      if (confirmedZero?.has(project.id)) return false;
      return true;
    }).length;

    return {
      period: p,
      netSales,
      directCosts,
      directMargin,
      generalCosts,
      generalCostDocuments,
      generalPersonnelCosts,
      operatingResult,
      pendingProjectCount,
      hasError,
      errors,
      currencyConversionPending: pendingMonths.has(p),
    };
  });
}

/**
 * Story 6.2: Profitability by Client, Project & Area
 *
 * These functions reuse Story 6.1's exact rules -- `net_amount` only,
 * non-voided sales only, tax never counted as cost or profit -- but
 * scope revenue to whatever is *directly tagged* to the entity
 * (`client_id`/`project_id`/`business_area_id` on `sales_documents`),
 * never apportioned or inferred (see spec Boundaries). Cost rollups per
 * entity are documented on each function; see the spec's Decisions
 * section for why each formula is what it is.
 *
 * `period` must be the first day of the month (e.g. "2026-09-01"),
 * matching computeMonthlyResult's own convention.
 */
export type ProfitabilityFigures = {
  revenue: number;
  costs: number;
  margin: number;
  /** See MonthlyResult.hasError: a query failed, so the figures may be understated. */
  hasError?: boolean;
  errors?: string[];
};

const zeroFigures: ProfitabilityFigures = { revenue: 0, costs: 0, margin: 0 };

/**
 * Story 6.4: exported so report pages can build drill-down links using
 * the exact same [start, end) range each compute* function sums over --
 * "end" is the exclusive first day of the following month, matching
 * getSalesDocuments/getCostDocuments' `to` filter convention.
 */
export function monthRange(period: string): { start: string; end: string } {
  const periodDate = new Date(period);
  const monthStart = new Date(
    Date.UTC(periodDate.getUTCFullYear(), periodDate.getUTCMonth(), 1),
  );
  const monthEnd = new Date(
    Date.UTC(periodDate.getUTCFullYear(), periodDate.getUTCMonth() + 1, 1),
  );
  return {
    start: monthStart.toISOString().slice(0, 10),
    end: monthEnd.toISOString().slice(0, 10),
  };
}

/** Computed share of a cost_allocations row, mirroring set_cost_allocations' own math. */
function allocationShare(row: {
  method: string;
  percentage: number | string | null;
  amount: number | string | null;
  cost_document_total: number;
}): number {
  if (row.method === "percentage") {
    return (row.cost_document_total * Number(row.percentage ?? 0)) / 100;
  }
  return Number(row.amount ?? 0);
}

/**
 * Client costs = cost_allocations rows targeting the client directly +
 * the full total_amount of every `direct` cost_documents row belonging
 * to a project whose client_id is that client (a project has exactly
 * one client, so this is an unambiguous rollup, not an apportionment).
 */
export async function computeClientProfitability(
  companyId: string,
  clientId: string,
  period: string,
): Promise<ProfitabilityFigures> {
  const user = await getSession();

  if (!user) {
    return zeroFigures;
  }

  const supabase = await createClient();
  const { start, end } = monthRange(period);

  const [
    { data: salesRows, error: salesError },
    { data: projectRows, error: projectError },
    { data: allocationRows, error: allocationError },
  ] = await Promise.all([
    selectAll(supabase
      .from("sales_documents")
      .select("net_amount, recognized_period")
      .eq("company_id", companyId)
      .eq("client_id", clientId)
      .eq("voided", false)
      .or(effectivePeriodFilter(start, end))),
    supabase.from("projects").select("id").eq("client_id", clientId),
    selectAll(supabase
      .from("cost_allocations")
      .select(
        "method, percentage, amount, cost_documents!inner(company_id, total_amount, document_date, recognized_period)",
      )
      .eq("client_id", clientId)
      .eq("cost_documents.company_id", companyId)
      .or(effectivePeriodFilter(start, end), { foreignTable: "cost_documents" })),
  ]);

  const errors = failedQueries({
    "las ventas": salesError,
    "los proyectos": projectError,
    "los prorrateos": allocationError,
  });

  const revenue = (salesRows ?? []).reduce(
    (sum, row) => sum + Number(row.net_amount ?? 0),
    0,
  );

  const projectIds = (projectRows ?? []).map((row) => row.id);

  let projectDirectCosts = 0;
  if (projectIds.length > 0) {
    const { data: costRows, error: costError } = await selectAll(supabase
      .from("cost_documents")
      .select("total_amount, project_id, recognized_period")
      .eq("company_id", companyId)
      .eq("classification", "direct")
      .in("project_id", projectIds)
      .or(effectivePeriodFilter(start, end)));

    errors.push(...failedQueries({ "los costos directos de los proyectos": costError }));

    projectDirectCosts = (costRows ?? []).reduce(
      (sum, row) => sum + Number(row.total_amount ?? 0),
      0,
    );
  }

  const allocatedCosts = (allocationRows ?? []).reduce((sum, row) => {
    const costDocument = Array.isArray(row.cost_documents)
      ? row.cost_documents[0]
      : row.cost_documents;
    return (
      sum +
      allocationShare({
        method: row.method,
        percentage: row.percentage,
        amount: row.amount,
        cost_document_total: Number(costDocument?.total_amount ?? 0),
      })
    );
  }, 0);

  const costs = projectDirectCosts + allocatedCosts;

  return { revenue, costs, margin: revenue - costs, hasError: errors.length > 0, errors };
}

/**
 * Area costs = cost_allocations rows targeting the area directly + the
 * full cost of every `direct` cost document belonging to a project
 * whose business_area_id is that area (symmetric to client -- a
 * project has exactly one area too).
 */
export async function computeAreaProfitability(
  companyId: string,
  areaId: string,
  period: string,
): Promise<ProfitabilityFigures> {
  const user = await getSession();

  if (!user) {
    return zeroFigures;
  }

  const supabase = await createClient();
  const { start, end } = monthRange(period);

  const [
    { data: directAreaSalesRows, error: salesError },
    { data: projectRows, error: projectError },
    { data: allocationRows, error: allocationError },
  ] = await Promise.all([
    selectAll(supabase
      .from("sales_documents")
      .select("id, net_amount, recognized_period")
      .eq("company_id", companyId)
      .eq("business_area_id", areaId)
      .eq("voided", false)
      .or(effectivePeriodFilter(start, end))),
    supabase.from("projects").select("id").eq("business_area_id", areaId),
    selectAll(supabase
      .from("cost_allocations")
      .select(
        "method, percentage, amount, cost_documents!inner(company_id, total_amount, document_date, recognized_period)",
      )
      .eq("business_area_id", areaId)
      .eq("cost_documents.company_id", companyId)
      .or(effectivePeriodFilter(start, end), { foreignTable: "cost_documents" })),
  ]);

  const errors = failedQueries({
    "las ventas": salesError,
    "los proyectos": projectError,
    "los prorrateos": allocationError,
  });

  const projectIds = (projectRows ?? []).map((row) => row.id);

  // Revenue counts a sale once whether it's tagged to the area directly
  // (business_area_id, e.g. Uruguay's quick-entry flow) or transitively
  // via a project in this area (the full sales form's project picker,
  // Story 6.2) -- symmetric with how area costs roll up from projects
  // below. Merged by id so a sale that somehow carries both never
  // double-counts.
  let projectAreaSalesRows: { id: string; net_amount: number | string }[] = [];
  if (projectIds.length > 0) {
    const { data, error: projectSalesError } = await selectAll(supabase
      .from("sales_documents")
      .select("id, net_amount, recognized_period")
      .eq("company_id", companyId)
      .in("project_id", projectIds)
      .eq("voided", false)
      .or(effectivePeriodFilter(start, end)));

    errors.push(...failedQueries({ "las ventas de los proyectos del área": projectSalesError }));
    projectAreaSalesRows = data ?? [];
  }

  const revenueById = new Map<string, number>();
  for (const row of directAreaSalesRows ?? []) {
    revenueById.set(row.id, Number(row.net_amount ?? 0));
  }
  for (const row of projectAreaSalesRows) {
    revenueById.set(row.id, Number(row.net_amount ?? 0));
  }
  const revenue = Array.from(revenueById.values()).reduce(
    (sum, amount) => sum + amount,
    0,
  );

  let projectDirectCosts = 0;
  if (projectIds.length > 0) {
    const { data: costRows, error: costError } = await selectAll(supabase
      .from("cost_documents")
      .select("total_amount, project_id, recognized_period")
      .eq("company_id", companyId)
      .eq("classification", "direct")
      .in("project_id", projectIds)
      .or(effectivePeriodFilter(start, end)));

    errors.push(...failedQueries({ "los costos directos de los proyectos": costError }));

    projectDirectCosts = (costRows ?? []).reduce(
      (sum, row) => sum + Number(row.total_amount ?? 0),
      0,
    );
  }

  const allocatedCosts = (allocationRows ?? []).reduce((sum, row) => {
    const costDocument = Array.isArray(row.cost_documents)
      ? row.cost_documents[0]
      : row.cost_documents;
    return (
      sum +
      allocationShare({
        method: row.method,
        percentage: row.percentage,
        amount: row.amount,
        cost_document_total: Number(costDocument?.total_amount ?? 0),
      })
    );
  }, 0);

  const costs = projectDirectCosts + allocatedCosts;

  return { revenue, costs, margin: revenue - costs, hasError: errors.length > 0, errors };
}

export type ProjectProfitability = ProfitabilityFigures & {
  accumulatedRevenue: number;
  accumulatedCosts: number;
  accumulatedMargin: number;
  budget: number | null;
  budgetVariance: number | null;
};

/**
 * Project costs = its own `direct` cost_documents (via project_id) +
 * cost_allocations rows targeting it (computed share) + work_allocations
 * rows targeting it (the `amount` field -- the real personnel cost
 * share; `hours` stays informational per Story 5.3). Returns both this
 * period's figures and accumulated (life-to-date) figures, per AC2.
 *
 * Story 6.3: also returns the project's `budget` (as captured on the
 * project, Story 1.6) and `budgetVariance` (`accumulatedCosts - budget`,
 * positive means over budget) -- "actual" is accumulated (life-to-date)
 * cost, matching this function's existing accumulated-figures
 * convention. `budgetVariance` is `null` whenever `budget` is `null`,
 * never a comparison against zero.
 */
export async function computeProjectProfitability(
  companyId: string,
  projectId: string,
  period: string,
): Promise<ProjectProfitability> {
  const user = await getSession();

  const zero: ProjectProfitability = {
    ...zeroFigures,
    accumulatedRevenue: 0,
    accumulatedCosts: 0,
    accumulatedMargin: 0,
    budget: null,
    budgetVariance: null,
  };

  if (!user) {
    return zero;
  }

  const supabase = await createClient();
  const { start, end } = monthRange(period);

  const [
    { data: projectRow, error: projectError },
    { data: periodSalesRows, error: periodSalesError },
    { data: allSalesRows, error: allSalesError },
    { data: periodDirectCostRows, error: periodDirectCostError },
    { data: allDirectCostRows, error: allDirectCostError },
    { data: periodAllocationRows, error: periodAllocationError },
    { data: allAllocationRows, error: allAllocationError },
    { data: periodWorkRows, error: periodWorkError },
    { data: allWorkRows, error: allWorkError },
  ] = await Promise.all([
    supabase
      .from("projects")
      .select("budget")
      .eq("company_id", companyId)
      .eq("id", projectId)
      .maybeSingle(),
    selectAll(supabase
      .from("sales_documents")
      .select("net_amount, recognized_period")
      .eq("company_id", companyId)
      .eq("project_id", projectId)
      .eq("voided", false)
      .or(effectivePeriodFilter(start, end))),
    selectAll(supabase
      .from("sales_documents")
      .select("net_amount")
      .eq("company_id", companyId)
      .eq("project_id", projectId)
      .eq("voided", false)),
    selectAll(supabase
      .from("cost_documents")
      .select("total_amount, recognized_period")
      .eq("company_id", companyId)
      .eq("project_id", projectId)
      .eq("classification", "direct")
      .or(effectivePeriodFilter(start, end))),
    selectAll(supabase
      .from("cost_documents")
      .select("total_amount")
      .eq("company_id", companyId)
      .eq("project_id", projectId)
      .eq("classification", "direct")),
    selectAll(supabase
      .from("cost_allocations")
      .select(
        "method, percentage, amount, cost_documents!inner(company_id, total_amount, document_date, recognized_period)",
      )
      .eq("project_id", projectId)
      .eq("cost_documents.company_id", companyId)
      .or(effectivePeriodFilter(start, end), { foreignTable: "cost_documents" })),
    selectAll(supabase
      .from("cost_allocations")
      .select(
        "method, percentage, amount, cost_documents!inner(company_id, total_amount)",
      )
      .eq("project_id", projectId)
      .eq("cost_documents.company_id", companyId)),
    selectAll(supabase
      .from("work_allocations")
      .select(
        "amount, personnel_costs!inner(period, personnel!inner(company_id))",
      )
      .eq("project_id", projectId)
      .eq("personnel_costs.personnel.company_id", companyId)
      .eq("personnel_costs.period", start)),
    selectAll(supabase
      .from("work_allocations")
      .select("amount, personnel_costs!inner(personnel!inner(company_id))")
      .eq("project_id", projectId)
      .eq("personnel_costs.personnel.company_id", companyId)),
  ]);

  const errors = failedQueries({
    "el proyecto": projectError,
    "las ventas del mes": periodSalesError,
    "las ventas acumuladas": allSalesError,
    "los costos directos del mes": periodDirectCostError,
    "los costos directos acumulados": allDirectCostError,
    "los prorrateos del mes": periodAllocationError,
    "los prorrateos acumulados": allAllocationError,
    "la mano de obra del mes": periodWorkError,
    "la mano de obra acumulada": allWorkError,
  });

  const sum = (rows: { net_amount?: unknown; total_amount?: unknown; amount?: unknown }[] | null) =>
    (rows ?? []).reduce(
      (total, row) =>
        total + Number(row.net_amount ?? row.total_amount ?? row.amount ?? 0),
      0,
    );

  const sumAllocations = (
    rows:
      | {
          method: string;
          percentage: number | string | null;
          amount: number | string | null;
          cost_documents: unknown;
        }[]
      | null,
  ) =>
    (rows ?? []).reduce((total, row) => {
      const costDocument = Array.isArray(row.cost_documents)
        ? row.cost_documents[0]
        : (row.cost_documents as { total_amount?: number } | null);
      return (
        total +
        allocationShare({
          method: row.method,
          percentage: row.percentage,
          amount: row.amount,
          cost_document_total: Number(costDocument?.total_amount ?? 0),
        })
      );
    }, 0);

  const revenue = sum(periodSalesRows);
  const accumulatedRevenue = sum(allSalesRows);

  const costs =
    sum(periodDirectCostRows) +
    sumAllocations(periodAllocationRows) +
    sum(periodWorkRows);

  const accumulatedCosts =
    sum(allDirectCostRows) +
    sumAllocations(allAllocationRows) +
    sum(allWorkRows);

  const budget =
    projectRow?.budget === undefined || projectRow?.budget === null
      ? null
      : Number(projectRow.budget);

  return {
    revenue,
    costs,
    margin: revenue - costs,
    accumulatedRevenue,
    accumulatedCosts,
    accumulatedMargin: accumulatedRevenue - accumulatedCosts,
    budget,
    budgetVariance: budget === null ? null : accumulatedCosts - budget,
    hasError: errors.length > 0,
    errors,
  };
}

export type ProfitabilityBreakdown = {
  clients: (ProfitabilityFigures & { id: string; name: string })[];
  projects: (ProjectProfitability & {
    id: string;
    name: string;
    clientName: string | null;
  })[];
  areas: (ProfitabilityFigures & { id: string; name: string })[];
  /** See MonthlyResult.hasError -- same meaning, same "never a guess" rule. */
  hasError: boolean;
  errors?: string[];
  /**
   * H02 fix: true when a *period*-scoped sales/cost/allocation/work row
   * carried a currency other than the company's and no rate could be
   * resolved -- that row was excluded from every figure above.
   * Deliberately says nothing about the accumulated project figures
   * (`accumulatedRevenue`/`accumulatedCosts`/`budgetVariance`), which
   * are still summed in whatever currency each row happens to carry --
   * see the note by `accumulatedRevenueByProject` below.
   */
  currencyConversionPending: boolean;
};

type AllocationRow = {
  method: string;
  percentage: number | string | null;
  amount: number | string | null;
  client_id: string | null;
  business_area_id: string | null;
  project_id: string | null;
  cost_documents:
    | { total_amount: number; net_amount: number; currency?: string }
    | { total_amount: number; net_amount: number; currency?: string }[]
    | null;
};

function costDocumentAmounts(
  row: Pick<AllocationRow, "cost_documents">,
): { total: number; net: number; currency: string | undefined } {
  const costDocument = Array.isArray(row.cost_documents)
    ? row.cost_documents[0]
    : row.cost_documents;
  return {
    total: Number(costDocument?.total_amount ?? 0),
    net: Number(costDocument?.net_amount ?? 0),
    currency: costDocument?.currency,
  };
}

/**
 * H01 fix: `set_cost_allocations` validates that a document's shares
 * (percentage or fixed amount) sum to `total_amount` -- tax-included --
 * by design (see the epic3/story2 migration's own check), so
 * `allocationShare()` above is correctly a gross figure. Scaling it by
 * this document's net/total ratio converts it to the net-basis share
 * every other cost figure in this file uses, while keeping shares of
 * the same document proportional to each other and summing back to
 * the document's net_amount (never its total_amount) across all of
 * its destinations.
 */
function toNetShare(grossShare: number, row: Pick<AllocationRow, "cost_documents">): number {
  const { total, net } = costDocumentAmounts(row);
  return total > 0 ? grossShare * (net / total) : 0;
}

/** Adds `amount` to `map[key]` (0 if absent), skipping a null/undefined key. */
function addTo(
  map: Map<string, number>,
  key: string | null | undefined,
  amount: number,
) {
  if (!key) return;
  map.set(key, (map.get(key) ?? 0) + amount);
}

/**
 * Lists all of a company's clients/projects/areas with their period (and,
 * for projects, accumulated) profitability figures, for the report page.
 * A client/project/area with zero directly-tagged sales legitimately
 * shows revenue: 0, never a guessed share.
 *
 * Computes the exact same figures as computeClientProfitability /
 * computeAreaProfitability / computeProjectProfitability, but fetches
 * each underlying table once for the whole company/period and buckets
 * rows by client/project/area id in memory, instead of running those
 * functions once per entity -- for a company with C clients, P projects
 * and A areas that was roughly (3*C + 9*P + 3*A) round trips; this is a
 * fixed ~10 regardless of how many clients/projects/areas exist.
 */
export async function getProfitabilityBreakdown(
  companyId: string,
  period: string,
): Promise<ProfitabilityBreakdown> {
  const user = await getSession();

  if (!user) {
    const [clients, projects, areas] = await Promise.all([
      getClients(companyId),
      getProjects(companyId),
      getBusinessAreas(companyId),
    ]);

    return {
      clients: clients.map((c) => ({ id: c.id, name: c.name, ...zeroFigures })),
      projects: projects.map((p) => ({
        id: p.id,
        name: p.name,
        clientName: p.client_name,
        ...zeroFigures,
        accumulatedRevenue: 0,
        accumulatedCosts: 0,
        accumulatedMargin: 0,
        budget: p.budget,
        budgetVariance: null,
      })),
      areas: areas.map((a) => ({ id: a.id, name: a.name, ...zeroFigures })),
      hasError: false,
      currencyConversionPending: false,
    };
  }

  const supabase = await createClient();
  const { start, end } = monthRange(period);

  // One wave: clients/projects/areas don't gate any of the 9 data
  // queries below (all scoped by companyId alone) -- they're only
  // needed afterward, to bucket results by id. Fetching them alongside
  // instead of first saves a full network round trip.
  const [
    { data: companyRow, error: companyError },
    clients,
    projects,
    areas,
    { data: periodSalesRows, error: periodSalesError },
    { data: accumulatedSalesRows, error: accumulatedSalesError },
    { data: periodDirectCostRows, error: periodDirectCostError },
    { data: accumulatedDirectCostRows, error: accumulatedDirectCostError },
    { data: periodAllocationRows, error: periodAllocationError },
    { data: accumulatedAllocationRows, error: accumulatedAllocationError },
    { data: periodWorkRows, error: periodWorkError },
    { data: accumulatedWorkRows, error: accumulatedWorkError },
    { data: periodRecurringRows, error: periodRecurringError },
  ] = await Promise.all([
    supabase.from("companies").select("currency").eq("id", companyId).maybeSingle(),
    getClients(companyId),
    getProjects(companyId),
    getBusinessAreas(companyId),
    selectAll(supabase
      .from("sales_documents")
      .select(
        "id, client_id, project_id, business_area_id, net_amount, document_type, currency",
      )
      .eq("company_id", companyId)
      .eq("voided", false)
      .or(effectivePeriodFilter(start, end))),
    selectAll(supabase
      .from("sales_documents")
      .select("project_id, net_amount, document_type")
      .eq("company_id", companyId)
      .eq("voided", false)
      .not("project_id", "is", null)),
    selectAll(supabase
      .from("cost_documents")
      .select("project_id, total_amount, net_amount, currency")
      .eq("company_id", companyId)
      .eq("classification", "direct")
      .or(effectivePeriodFilter(start, end))),
    selectAll(supabase
      .from("cost_documents")
      .select("project_id, total_amount, net_amount")
      .eq("company_id", companyId)
      .eq("classification", "direct")
      .not("project_id", "is", null)),
    selectAll(supabase
      .from("cost_allocations")
      .select(
        "method, percentage, amount, client_id, business_area_id, project_id, cost_documents!inner(company_id, total_amount, net_amount, currency, document_date, recognized_period)",
      )
      .eq("cost_documents.company_id", companyId)
      .or(effectivePeriodFilter(start, end), { foreignTable: "cost_documents" })),
    selectAll(supabase
      .from("cost_allocations")
      .select(
        "method, percentage, amount, client_id, business_area_id, project_id, cost_documents!inner(company_id, total_amount, net_amount)",
      )
      .eq("cost_documents.company_id", companyId)
      .not("project_id", "is", null)),
    selectAll(supabase
      .from("work_allocations")
      .select(
        "project_id, amount, personnel_costs!inner(period, currency, personnel!inner(company_id))",
      )
      .eq("personnel_costs.personnel.company_id", companyId)
      .eq("personnel_costs.period", start)),
    selectAll(supabase
      .from("work_allocations")
      .select("project_id, amount, personnel_costs!inner(personnel!inner(company_id))")
      .eq("personnel_costs.personnel.company_id", companyId)),
    // plan-servicios-recurrentes.md Phase 8: recurring services are not
    // `trabajos` (they don't come from a quote) and are deliberately
    // never forced into `projects` -- their revenue/cost is UNIONed
    // into client/area figures here instead, alongside (not replacing)
    // everything computed above from sales_documents/cost_documents.
    // Only 'invoiced'/'collected' occurrences count -- like every other
    // figure in this file, revenue is recognized from a real, confirmed
    // document/action, never a still-pending forecast (a
    // 'pending_invoice' occurrence contributes 0, same "never a guessed
    // share" rule as everything else here). Excludes any occurrence
    // with a sales_document_id: that means Nubox auto-matched it to a
    // real invoice (Phase 7), which the sales_documents query above
    // *already* counts by its own document_date -- unioning this too
    // would double the revenue. Only occurrences invoiced/collected
    // through the manual Facturar/Cobrar taps on the Pendientes screen
    // (Uruguay, or a Chile client marked before the next Nubox import)
    // have no underlying sales_documents row at all, which is exactly
    // what would otherwise stay invisible to this report -- and
    // exactly what this union exists for. Cost is the fixed monthly
    // cost for a non-pooled service, or its share of a repartido cost
    // pool (recurring_service_cost_allocations) for a pooled one (e.g.
    // MS licenses) -- 0 if that pool hasn't been repartido yet, again
    // never guessed.
    //
    // Which month an occurrence lands in: the month it was actually
    // invoiced (invoiced_at, stamped by the Facturar tap), full amount
    // -- the same invoice-date basis the sales_documents above use via
    // document_date, and confirmed with the user for annual services
    // too (their `period` is January 1st of the year billed, which
    // would otherwise put every annual sale in January). Rows with no
    // invoiced_at (e.g. loaded by hand already invoiced) fall back to
    // invoice_due_date's month, then to the period's.
    selectAll(supabase
      .from("recurring_service_occurrences")
      .select(
        "amount, currency, recurring_services!inner(company_id, client_id, business_area_id, uses_cost_pool, fixed_monthly_cost), recurring_service_cost_allocations(allocated_amount)",
      )
      .eq("recurring_services.company_id", companyId)
      .in("status", ["invoiced", "collected"])
      .is("sales_document_id", null)
      .or(
        [
          `and(invoiced_at.gte.${start},invoiced_at.lt.${end})`,
          `and(invoiced_at.is.null,invoice_due_date.gte.${start},invoice_due_date.lt.${end})`,
          `and(invoiced_at.is.null,invoice_due_date.is.null,period.gte.${start},period.lt.${end})`,
        ].join(","),
      )),
  ]);

  const errors = failedQueries({
    "la empresa": companyError,
    "las ventas del mes": periodSalesError,
    "las ventas acumuladas": accumulatedSalesError,
    "los costos directos del mes": periodDirectCostError,
    "los costos directos acumulados": accumulatedDirectCostError,
    "los prorrateos del mes": periodAllocationError,
    "los prorrateos acumulados": accumulatedAllocationError,
    "la mano de obra del mes": periodWorkError,
    "la mano de obra acumulada": accumulatedWorkError,
    "los servicios recurrentes": periodRecurringError,
  });
  const hasError = errors.length > 0;

  // See computeMonthlyResult's identical comment: unreachable for any
  // real caller (RLS/membership already guarantee the row exists).
  const companyCurrency = (companyRow?.currency ?? "?") as string;
  const rates = await resolveCurrencyRates(companyCurrency, start);
  let currencyConversionPending = false;
  const convert = (amount: number, currency: string): number => {
    const { amount: converted, pending } = convertToCompanyCurrency(
      amount,
      currency,
      rates,
    );
    if (pending) currencyConversionPending = true;
    return converted;
  };

  const projectById = new Map(projects.map((p) => [p.id, p]));

  // Revenue: bucketed per client (direct client_id tag only) and per
  // project (direct project_id tag), plus per area -- an area's revenue
  // is every sale tagged to it directly OR via its project, counted once
  // per area even if both tags point to the same area (mirrors the
  // id-keyed Map merge computeAreaProfitability used per area).
  const revenueByClient = new Map<string, number>();
  const revenueByProject = new Map<string, number>();
  const revenueByArea = new Map<string, number>();
  for (const row of periodSalesRows ?? []) {
    const amount = convert(signedSalesAmount(row), row.currency);
    addTo(revenueByClient, row.client_id, amount);
    addTo(revenueByProject, row.project_id, amount);

    const areaIds = new Set<string>();
    if (row.business_area_id) areaIds.add(row.business_area_id);
    const project = row.project_id ? projectById.get(row.project_id) : undefined;
    if (project) areaIds.add(project.business_area_id);
    for (const areaId of areaIds) {
      addTo(revenueByArea, areaId, amount);
    }
  }

  // H02 note: NOT currency-converted, unlike every period figure above.
  // Each row here can be from any past month, so a correct conversion
  // needs that row's own effective-period rate, not this call's single
  // `period` -- and accumulated figures already have a separate,
  // unresolved scope problem (H11: no upper cutoff either), so bolting
  // a partial currency fix onto them here would still be wrong in a
  // different way. Left as a plain sum until H11 gives this a real
  // per-row-period design to convert against.
  const accumulatedRevenueByProject = new Map<string, number>();
  for (const row of accumulatedSalesRows ?? []) {
    addTo(accumulatedRevenueByProject, row.project_id, signedSalesAmount(row));
  }

  // Direct costs: bucketed per project directly, then rolled up to that
  // project's client/area (a project has exactly one of each). H01 fix:
  // net_amount (tax-excluded), matching computeMonthlyResult's basis --
  // not total_amount.
  const directCostByProjectPeriod = new Map<string, number>();
  for (const row of periodDirectCostRows ?? []) {
    addTo(
      directCostByProjectPeriod,
      row.project_id,
      convert(Number(row.net_amount ?? 0), row.currency),
    );
  }
  const directCostByProjectAccumulated = new Map<string, number>();
  for (const row of accumulatedDirectCostRows ?? []) {
    addTo(
      directCostByProjectAccumulated,
      row.project_id,
      Number(row.net_amount ?? 0),
    );
  }

  const directCostByClient = new Map<string, number>();
  const directCostByArea = new Map<string, number>();
  for (const [projectId, amount] of directCostByProjectPeriod) {
    const project = projectById.get(projectId);
    if (!project) continue;
    addTo(directCostByClient, project.client_id, amount);
    addTo(directCostByArea, project.business_area_id, amount);
  }

  // Allocations: a row targets whichever of client_id/business_area_id/
  // project_id it carries (independently, as the original per-entity
  // queries did -- a row could in principle target more than one).
  const allocByClientPeriod = new Map<string, number>();
  const allocByAreaPeriod = new Map<string, number>();
  const allocByProjectPeriod = new Map<string, number>();
  for (const row of (periodAllocationRows ?? []) as AllocationRow[]) {
    const netShare = toNetShare(
      allocationShare({
        method: row.method,
        percentage: row.percentage,
        amount: row.amount,
        cost_document_total: costDocumentAmounts(row).total,
      }),
      row,
    );
    const share = convert(netShare, costDocumentAmounts(row).currency ?? companyCurrency);
    addTo(allocByClientPeriod, row.client_id, share);
    addTo(allocByAreaPeriod, row.business_area_id, share);
    addTo(allocByProjectPeriod, row.project_id, share);
  }

  // H02 note: not converted -- same reasoning as accumulatedRevenueByProject above.
  const allocByProjectAccumulated = new Map<string, number>();
  for (const row of (accumulatedAllocationRows ?? []) as AllocationRow[]) {
    addTo(
      allocByProjectAccumulated,
      row.project_id,
      toNetShare(
        allocationShare({
          method: row.method,
          percentage: row.percentage,
          amount: row.amount,
          cost_document_total: costDocumentAmounts(row).total,
        }),
        row,
      ),
    );
  }

  const workByProjectPeriod = new Map<string, number>();
  for (const row of periodWorkRows ?? []) {
    const personnelCost = Array.isArray(row.personnel_costs)
      ? row.personnel_costs[0]
      : row.personnel_costs;
    const amount = convert(
      Number(row.amount ?? 0),
      personnelCost?.currency ?? companyCurrency,
    );
    addTo(workByProjectPeriod, row.project_id, amount);
  }
  // H02 note: not converted -- same reasoning as accumulatedRevenueByProject above.
  const workByProjectAccumulated = new Map<string, number>();
  for (const row of accumulatedWorkRows ?? []) {
    addTo(workByProjectAccumulated, row.project_id, Number(row.amount ?? 0));
  }

  // Recurring services: revenue/cost by client and by area, unioned
  // into the totals below -- see the query above for what counts and
  // why. currency conversion reuses the exact same `convert()` (and
  // therefore the exact same period-of exchange rates) as every other
  // figure in this function.
  const recurringRevenueByClient = new Map<string, number>();
  const recurringCostByClient = new Map<string, number>();
  const recurringRevenueByArea = new Map<string, number>();
  const recurringCostByArea = new Map<string, number>();
  type RecurringOccurrenceRow = {
    amount: number | string;
    currency: string;
    recurring_services:
      | {
          client_id: string;
          business_area_id: string | null;
          uses_cost_pool: boolean;
          fixed_monthly_cost: number | string | null;
        }
      | {
          client_id: string;
          business_area_id: string | null;
          uses_cost_pool: boolean;
          fixed_monthly_cost: number | string | null;
        }[]
      | null;
    recurring_service_cost_allocations: { allocated_amount: number | string }[] | null;
  };
  for (const row of (periodRecurringRows ?? []) as RecurringOccurrenceRow[]) {
    const service = Array.isArray(row.recurring_services)
      ? row.recurring_services[0]
      : row.recurring_services;
    if (!service) continue;

    const revenue = convert(Number(row.amount ?? 0), row.currency);
    addTo(recurringRevenueByClient, service.client_id, revenue);
    addTo(recurringRevenueByArea, service.business_area_id, revenue);

    const rawCost = service.uses_cost_pool
      ? Number(row.recurring_service_cost_allocations?.[0]?.allocated_amount ?? 0)
      : Number(service.fixed_monthly_cost ?? 0);
    const cost = convert(rawCost, row.currency);
    addTo(recurringCostByClient, service.client_id, cost);
    addTo(recurringCostByArea, service.business_area_id, cost);
  }

  const figures = (revenue: number, costs: number): ProfitabilityFigures => ({
    revenue,
    costs,
    margin: revenue - costs,
  });

  return {
    clients: clients.map((client) => {
      const revenue =
        (revenueByClient.get(client.id) ?? 0) +
        (recurringRevenueByClient.get(client.id) ?? 0);
      const costs =
        (directCostByClient.get(client.id) ?? 0) +
        (allocByClientPeriod.get(client.id) ?? 0) +
        (recurringCostByClient.get(client.id) ?? 0);
      return { id: client.id, name: client.name, ...figures(revenue, costs) };
    }),
    projects: projects.map((project) => {
      const revenue = revenueByProject.get(project.id) ?? 0;
      const costs =
        (directCostByProjectPeriod.get(project.id) ?? 0) +
        (allocByProjectPeriod.get(project.id) ?? 0) +
        (workByProjectPeriod.get(project.id) ?? 0);
      const accumulatedRevenue = accumulatedRevenueByProject.get(project.id) ?? 0;
      const accumulatedCosts =
        (directCostByProjectAccumulated.get(project.id) ?? 0) +
        (allocByProjectAccumulated.get(project.id) ?? 0) +
        (workByProjectAccumulated.get(project.id) ?? 0);
      const budget = project.budget === null ? null : Number(project.budget);

      return {
        id: project.id,
        name: project.name,
        clientName: project.client_name,
        ...figures(revenue, costs),
        accumulatedRevenue,
        accumulatedCosts,
        accumulatedMargin: accumulatedRevenue - accumulatedCosts,
        budget,
        budgetVariance: budget === null ? null : accumulatedCosts - budget,
      };
    }),
    areas: areas.map((area) => {
      const revenue =
        (revenueByArea.get(area.id) ?? 0) + (recurringRevenueByArea.get(area.id) ?? 0);
      const costs =
        (directCostByArea.get(area.id) ?? 0) +
        (allocByAreaPeriod.get(area.id) ?? 0) +
        (recurringCostByArea.get(area.id) ?? 0);
      return { id: area.id, name: area.name, ...figures(revenue, costs) };
    }),
    hasError,
    errors,
    currencyConversionPending,
  };
}

/**
 * Story 6.5: Consolidated Chile + Uruguay Result in USD.
 *
 * Runs Story 6.1's computeMonthlyResult once per company the calling
 * user belongs to (not hardcoded to exactly two -- see spec Boundaries),
 * converts each company's operatingResult to USD, and sums into one
 * total. A company already reporting in USD (`currency === 'USD'`) is
 * included at face value, no conversion/rate lookup needed. A company
 * whose currency's rate can't be resolved (fetch failure + no snapshot
 * yet for this period) is excluded from `totalUsd` and listed in
 * `pendingRateCompanies` -- never silently treated as zero (per spec
 * Boundaries/Never).
 *
 * Only CLP and UYU are triangulated via MonedAPI/getOrSnapshotRate;
 * any other non-USD currency a company might carry is treated the same
 * way as an unresolvable rate (pending), since this story only built
 * conversion for Chile/Uruguay's currencies.
 */
export type ConsolidatedCompanyResult = {
  companyId: string;
  companyName: string;
  currency: string;
  result: MonthlyResult;
  usdAmount: number | null;
  ratePending: boolean;
};

export type ConsolidatedResult = {
  companies: ConsolidatedCompanyResult[];
  totalUsd: number;
  pendingRateCompanies: { companyId: string; companyName: string }[];
  /** True when any company's underlying computeMonthlyResult hit a query error. */
  hasError: boolean;
};

export async function computeConsolidatedResult(
  period: string,
): Promise<ConsolidatedResult> {
  const companies = await getUserCompanies();

  const rateableCurrencies = new Set(["CLP", "UYU"]);

  const companyResults = await Promise.all(
    companies.map(async (company) => {
      const result = await computeMonthlyResult(company.id, period);

      if (company.currency === "USD") {
        return {
          companyId: company.id,
          companyName: company.name,
          currency: company.currency,
          result,
          usdAmount: result.operatingResult,
          ratePending: false,
        } satisfies ConsolidatedCompanyResult;
      }

      if (!rateableCurrencies.has(company.currency)) {
        return {
          companyId: company.id,
          companyName: company.name,
          currency: company.currency,
          result,
          usdAmount: null,
          ratePending: true,
        } satisfies ConsolidatedCompanyResult;
      }

      const rate = await getOrSnapshotRate(
        company.currency as "CLP" | "UYU",
        period,
      );

      if (rate === null) {
        return {
          companyId: company.id,
          companyName: company.name,
          currency: company.currency,
          result,
          usdAmount: null,
          ratePending: true,
        } satisfies ConsolidatedCompanyResult;
      }

      return {
        companyId: company.id,
        companyName: company.name,
        currency: company.currency,
        result,
        usdAmount: result.operatingResult * rate,
        ratePending: false,
      } satisfies ConsolidatedCompanyResult;
    }),
  );

  const totalUsd = companyResults.reduce(
    (sum, company) => sum + (company.usdAmount ?? 0),
    0,
  );

  const pendingRateCompanies = companyResults
    .filter((company) => company.ratePending)
    .map((company) => ({
      companyId: company.companyId,
      companyName: company.companyName,
    }));

  const hasError = companyResults.some((company) => company.result.hasError);

  return { companies: companyResults, totalUsd, pendingRateCompanies, hasError };
}
