import { createClient } from "@/lib/supabase/server";
import { getProjectCostStatus } from "@/lib/dal";

/**
 * Story 6.1: Monthly Result Report -- the shared calculation engine
 * Epic 6's later reports (6.2 especially) will also call. Computes a
 * single company's net sales, direct margin, and operating result for
 * one calendar month, purely from underlying documents -- never a
 * manually entered figure.
 *
 * All figures use `net_amount` (tax-excluded) on both sides --
 * recoverable VAT is never profit or expense. A voided sales document
 * is excluded entirely. Direct costs are `cost_documents` where
 * `classification = 'direct'`; general costs are `cost_documents`
 * where `classification = 'general'` (summed by total net_amount, not
 * broken down by `cost_allocations` target -- that's Story 6.2's
 * concern) plus the period's total `personnel_costs.amount` (allocated
 * or not -- at company level the money is spent either way).
 *
 * `period` must be the first day of the month (e.g. "2026-09-01"),
 * matching `getProjectCostStatus`'s own convention and
 * `personnel_costs.period`'s check constraint.
 *
 * Mixed-currency documents within one company are out of scope (see
 * spec Decisions) -- every figure here is a plain sum in the company's
 * own currency, no conversion.
 */
export type MonthlyResult = {
  netSales: number;
  directCosts: number;
  directMargin: number;
  generalCosts: number;
  operatingResult: number;
  pendingProjectCount: number;
};

export async function computeMonthlyResult(
  companyId: string,
  period: string,
): Promise<MonthlyResult> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const zero: MonthlyResult = {
    netSales: 0,
    directCosts: 0,
    directMargin: 0,
    generalCosts: 0,
    operatingResult: 0,
    pendingProjectCount: 0,
  };

  if (!user) {
    return zero;
  }

  const periodDate = new Date(period);
  const monthStart = new Date(
    Date.UTC(periodDate.getUTCFullYear(), periodDate.getUTCMonth(), 1),
  );
  const monthEnd = new Date(
    Date.UTC(periodDate.getUTCFullYear(), periodDate.getUTCMonth() + 1, 1),
  );
  const monthStartStr = monthStart.toISOString().slice(0, 10);
  const monthEndStr = monthEnd.toISOString().slice(0, 10);

  const [
    { data: salesRows, error: salesError },
    { data: costRows, error: costError },
    { data: personnelIdRows, error: personnelIdError },
    projectsWithStatus,
  ] = await Promise.all([
    supabase
      .from("sales_documents")
      .select("net_amount")
      .eq("company_id", companyId)
      .eq("voided", false)
      .gte("document_date", monthStartStr)
      .lt("document_date", monthEndStr),
    supabase
      .from("cost_documents")
      .select("net_amount, classification")
      .eq("company_id", companyId)
      .gte("document_date", monthStartStr)
      .lt("document_date", monthEndStr),
    supabase.from("personnel").select("id").eq("company_id", companyId),
    getProjectCostStatus(companyId, monthStartStr),
  ]);

  if (salesError) {
    console.error(salesError);
  }
  if (costError) {
    console.error(costError);
  }
  if (personnelIdError) {
    console.error(personnelIdError);
  }

  const personnelIds = (personnelIdRows ?? []).map((row) => row.id);

  let personnelRows: { amount: number | string }[] = [];
  if (personnelIds.length > 0) {
    const { data, error: personnelError } = await supabase
      .from("personnel_costs")
      .select("amount")
      .in("personnel_id", personnelIds)
      .eq("period", monthStartStr);

    if (personnelError) {
      console.error(personnelError);
    }
    personnelRows = data ?? [];
  }

  const netSales = (salesRows ?? []).reduce(
    (sum, row) => sum + Number(row.net_amount ?? 0),
    0,
  );

  const directCosts = (costRows ?? [])
    .filter((row) => row.classification === "direct")
    .reduce((sum, row) => sum + Number(row.net_amount ?? 0), 0);

  const generalCostDocuments = (costRows ?? [])
    .filter((row) => row.classification === "general")
    .reduce((sum, row) => sum + Number(row.net_amount ?? 0), 0);

  const personnelCosts = personnelRows.reduce(
    (sum, row) => sum + Number(row.amount ?? 0),
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
    operatingResult,
    pendingProjectCount,
  };
}
