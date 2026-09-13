import { createClient } from "@/lib/supabase/server";
import {
  getProjectCostStatus,
  getClients,
  getProjects,
  getBusinessAreas,
} from "@/lib/dal";

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
    generalCostDocuments: 0,
    generalPersonnelCosts: 0,
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
    generalCostDocuments,
    generalPersonnelCosts: personnelCosts,
    operatingResult,
    pendingProjectCount,
  };
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
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return zeroFigures;
  }

  const { start, end } = monthRange(period);

  const [
    { data: salesRows, error: salesError },
    { data: projectRows, error: projectError },
    { data: allocationRows, error: allocationError },
  ] = await Promise.all([
    supabase
      .from("sales_documents")
      .select("net_amount")
      .eq("company_id", companyId)
      .eq("client_id", clientId)
      .eq("voided", false)
      .gte("document_date", start)
      .lt("document_date", end),
    supabase.from("projects").select("id").eq("client_id", clientId),
    supabase
      .from("cost_allocations")
      .select(
        "method, percentage, amount, cost_documents!inner(company_id, total_amount, document_date)",
      )
      .eq("client_id", clientId)
      .eq("cost_documents.company_id", companyId)
      .gte("cost_documents.document_date", start)
      .lt("cost_documents.document_date", end),
  ]);

  if (salesError) console.error(salesError);
  if (projectError) console.error(projectError);
  if (allocationError) console.error(allocationError);

  const revenue = (salesRows ?? []).reduce(
    (sum, row) => sum + Number(row.net_amount ?? 0),
    0,
  );

  const projectIds = (projectRows ?? []).map((row) => row.id);

  let projectDirectCosts = 0;
  if (projectIds.length > 0) {
    const { data: costRows, error: costError } = await supabase
      .from("cost_documents")
      .select("total_amount, project_id")
      .eq("company_id", companyId)
      .eq("classification", "direct")
      .in("project_id", projectIds)
      .gte("document_date", start)
      .lt("document_date", end);

    if (costError) console.error(costError);

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

  return { revenue, costs, margin: revenue - costs };
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
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return zeroFigures;
  }

  const { start, end } = monthRange(period);

  const [
    { data: directAreaSalesRows, error: salesError },
    { data: projectRows, error: projectError },
    { data: allocationRows, error: allocationError },
  ] = await Promise.all([
    supabase
      .from("sales_documents")
      .select("id, net_amount")
      .eq("company_id", companyId)
      .eq("business_area_id", areaId)
      .eq("voided", false)
      .gte("document_date", start)
      .lt("document_date", end),
    supabase.from("projects").select("id").eq("business_area_id", areaId),
    supabase
      .from("cost_allocations")
      .select(
        "method, percentage, amount, cost_documents!inner(company_id, total_amount, document_date)",
      )
      .eq("business_area_id", areaId)
      .eq("cost_documents.company_id", companyId)
      .gte("cost_documents.document_date", start)
      .lt("cost_documents.document_date", end),
  ]);

  if (salesError) console.error(salesError);
  if (projectError) console.error(projectError);
  if (allocationError) console.error(allocationError);

  const projectIds = (projectRows ?? []).map((row) => row.id);

  // Revenue counts a sale once whether it's tagged to the area directly
  // (business_area_id, e.g. Uruguay's quick-entry flow) or transitively
  // via a project in this area (the full sales form's project picker,
  // Story 6.2) -- symmetric with how area costs roll up from projects
  // below. Merged by id so a sale that somehow carries both never
  // double-counts.
  let projectAreaSalesRows: { id: string; net_amount: number | string }[] = [];
  if (projectIds.length > 0) {
    const { data, error: projectSalesError } = await supabase
      .from("sales_documents")
      .select("id, net_amount")
      .eq("company_id", companyId)
      .in("project_id", projectIds)
      .eq("voided", false)
      .gte("document_date", start)
      .lt("document_date", end);

    if (projectSalesError) console.error(projectSalesError);
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
    const { data: costRows, error: costError } = await supabase
      .from("cost_documents")
      .select("total_amount, project_id")
      .eq("company_id", companyId)
      .eq("classification", "direct")
      .in("project_id", projectIds)
      .gte("document_date", start)
      .lt("document_date", end);

    if (costError) console.error(costError);

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

  return { revenue, costs, margin: revenue - costs };
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
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

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
    supabase
      .from("sales_documents")
      .select("net_amount")
      .eq("company_id", companyId)
      .eq("project_id", projectId)
      .eq("voided", false)
      .gte("document_date", start)
      .lt("document_date", end),
    supabase
      .from("sales_documents")
      .select("net_amount")
      .eq("company_id", companyId)
      .eq("project_id", projectId)
      .eq("voided", false),
    supabase
      .from("cost_documents")
      .select("total_amount")
      .eq("company_id", companyId)
      .eq("project_id", projectId)
      .eq("classification", "direct")
      .gte("document_date", start)
      .lt("document_date", end),
    supabase
      .from("cost_documents")
      .select("total_amount")
      .eq("company_id", companyId)
      .eq("project_id", projectId)
      .eq("classification", "direct"),
    supabase
      .from("cost_allocations")
      .select(
        "method, percentage, amount, cost_documents!inner(company_id, total_amount, document_date)",
      )
      .eq("project_id", projectId)
      .eq("cost_documents.company_id", companyId)
      .gte("cost_documents.document_date", start)
      .lt("cost_documents.document_date", end),
    supabase
      .from("cost_allocations")
      .select(
        "method, percentage, amount, cost_documents!inner(company_id, total_amount)",
      )
      .eq("project_id", projectId)
      .eq("cost_documents.company_id", companyId),
    supabase
      .from("work_allocations")
      .select(
        "amount, personnel_costs!inner(period, personnel!inner(company_id))",
      )
      .eq("project_id", projectId)
      .eq("personnel_costs.personnel.company_id", companyId)
      .eq("personnel_costs.period", start),
    supabase
      .from("work_allocations")
      .select("amount, personnel_costs!inner(personnel!inner(company_id))")
      .eq("project_id", projectId)
      .eq("personnel_costs.personnel.company_id", companyId),
  ]);

  for (const error of [
    projectError,
    periodSalesError,
    allSalesError,
    periodDirectCostError,
    allDirectCostError,
    periodAllocationError,
    allAllocationError,
    periodWorkError,
    allWorkError,
  ]) {
    if (error) console.error(error);
  }

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
};

/**
 * Lists all of a company's clients/projects/areas with their period (and,
 * for projects, accumulated) profitability figures, for the report page.
 * A client/project/area with zero directly-tagged sales legitimately
 * shows revenue: 0, never a guessed share.
 */
export async function getProfitabilityBreakdown(
  companyId: string,
  period: string,
): Promise<ProfitabilityBreakdown> {
  const [clients, projects, areas] = await Promise.all([
    getClients(companyId),
    getProjects(companyId),
    getBusinessAreas(companyId),
  ]);

  const [clientFigures, projectFigures, areaFigures] = await Promise.all([
    Promise.all(
      clients.map((client) =>
        computeClientProfitability(companyId, client.id, period),
      ),
    ),
    Promise.all(
      projects.map((project) =>
        computeProjectProfitability(companyId, project.id, period),
      ),
    ),
    Promise.all(
      areas.map((area) => computeAreaProfitability(companyId, area.id, period)),
    ),
  ]);

  return {
    clients: clients.map((client, i) => ({
      id: client.id,
      name: client.name,
      ...clientFigures[i],
    })),
    projects: projects.map((project, i) => ({
      id: project.id,
      name: project.name,
      clientName: project.client_name,
      ...projectFigures[i],
    })),
    areas: areas.map((area, i) => ({
      id: area.id,
      name: area.name,
      ...areaFigures[i],
    })),
  };
}
