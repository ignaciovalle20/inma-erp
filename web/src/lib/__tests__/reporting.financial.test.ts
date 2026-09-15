/**
 * Fixture regression tests for confirmed findings from the 2026-09-15
 * technical audit (H01, H02, H03). Same methodology the audit itself
 * used in G.2: real reporting.ts code, fixture rows standing in for
 * Supabase responses, no real SQL.
 *
 * H01 -- monthly result uses net_amount (tax-excluded) everywhere, but
 * getProfitabilityBreakdown's per-project/client/area cost figures use
 * cost_documents.total_amount (tax-included) instead. A cost with
 * net 100 / IVA 19 shows as 100 in one report and 119 in the other.
 *
 * H02 -- a sales/cost/personnel document's currency doesn't have to
 * match its company's (no schema constraint ties them), and nothing in
 * reporting.ts converted between them -- a USD document was summed
 * numerically into a CLP total as if it were also CLP.
 *
 * H03 -- a positive-net credit_note document is summed into net sales
 * like an invoice, instead of reducing it. Nothing in reporting.ts
 * branches on document_type at all today.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createFakeSupabase, type FakeResult } from "./fakeSupabase";

const fakeState: {
  queues: Record<string, FakeResult[]>;
  rates: Record<string, number | null>;
} = { queues: {}, rates: {} };

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => createFakeSupabase(fakeState.queues),
}));

vi.mock("@/lib/dal", () => ({
  getSession: async () => ({ id: "user-1" }),
  getUserCompanies: async () => [],
  getClients: async () => [{ id: "client-1", name: "Cliente 1" }],
  getBusinessAreas: async () => [],
  getProjects: async () => [
    {
      id: "project-1",
      name: "Proyecto 1",
      client_id: "client-1",
      client_name: "Cliente 1",
      business_area_id: null,
      business_area_name: null,
      budget: null,
      status: "active",
    },
    {
      id: "project-2",
      name: "Proyecto 2",
      client_id: "client-1",
      client_name: "Cliente 1",
      business_area_id: null,
      business_area_name: null,
      budget: null,
      status: "active",
    },
  ],
  getProjectCostStatus: async () => [],
}));

// getConversionRate defaults every pair to 1 (a no-op conversion) unless
// a test sets a specific rate with setRate() -- keeps H01/H03 tests,
// which never mix currencies, unaffected by this mock's existence.
vi.mock("@/lib/exchangeRates", () => ({
  getOrSnapshotRate: async () => null,
  getConversionRate: async (from: string, to: string, period: string) => {
    if (from === to) return 1;
    const key = `${from}:${to}:${period}`;
    return key in fakeState.rates ? fakeState.rates[key] : 1;
  },
}));

function queue(table: string, ...results: FakeResult[]) {
  fakeState.queues[table] = results;
}

function setRate(from: string, to: string, period: string, rate: number | null) {
  fakeState.rates[`${from}:${to}:${period}`] = rate;
}

function queueCompany(currency: string) {
  queue("companies", { data: { currency }, error: null });
}

beforeEach(() => {
  fakeState.queues = {};
  fakeState.rates = {};
});

describe("H01 -- getProfitabilityBreakdown cost basis", () => {
  it("uses the same net (tax-excluded) basis as computeMonthlyResult, not total_amount", async () => {
    const { getProfitabilityBreakdown } = await import("@/lib/reporting");

    queueCompany("CLP");
    // sales_documents: period-scoped, then accumulated -- empty, this
    // scenario is cost-only.
    queue("sales_documents", { data: [], error: null }, { data: [], error: null });

    // cost_documents: period-scoped direct costs, then accumulated.
    // A single direct cost on project-1: net 100, IVA 19, total 119.
    const directCostRow = {
      project_id: "project-1",
      total_amount: 119,
      net_amount: 100,
      currency: "CLP",
    };
    queue(
      "cost_documents",
      { data: [directCostRow], error: null },
      { data: [directCostRow], error: null },
    );

    // No allocations, no work allocations, for either window.
    queue("cost_allocations", { data: [], error: null }, { data: [], error: null });
    queue("work_allocations", { data: [], error: null }, { data: [], error: null });

    const breakdown = await getProfitabilityBreakdown("company-1", "2026-09-01");
    const project = breakdown.projects.find((p) => p.id === "project-1");

    expect(project).toBeDefined();
    // This is the number computeMonthlyResult would show for the same
    // underlying cost (net_amount, no tax) -- the two reports must
    // reconcile. Today the code sums total_amount and this is 119.
    expect(project!.costs).toBe(100);
  });
});

describe("H01 -- percentage-based cost_allocations convert to net basis", () => {
  it("splits a general document's net_amount proportionally, not its total_amount", async () => {
    const { getProfitabilityBreakdown } = await import("@/lib/reporting");

    queueCompany("CLP");
    queue("sales_documents", { data: [], error: null }, { data: [], error: null });
    queue("cost_documents", { data: [], error: null }, { data: [], error: null });

    // A general cost document (net 100, IVA 19, total 119) split 50/50
    // by percentage across project-1 and project-2. set_cost_allocations
    // requires shares to sum to total_amount (119), so each row's gross
    // share is 59.5 -- toNetShare must scale it down to 50 (net) each,
    // not leave it at 59.5.
    const costDocuments = { total_amount: 119, net_amount: 100, currency: "CLP" };
    const allocationRows = [
      {
        method: "percentage",
        percentage: 50,
        amount: null,
        client_id: null,
        business_area_id: null,
        project_id: "project-1",
        cost_documents: costDocuments,
      },
      {
        method: "percentage",
        percentage: 50,
        amount: null,
        client_id: null,
        business_area_id: null,
        project_id: "project-2",
        cost_documents: costDocuments,
      },
    ];
    queue(
      "cost_allocations",
      { data: allocationRows, error: null },
      { data: [], error: null },
    );
    queue("work_allocations", { data: [], error: null }, { data: [], error: null });

    const breakdown = await getProfitabilityBreakdown("company-1", "2026-09-01");
    const project1 = breakdown.projects.find((p) => p.id === "project-1");
    const project2 = breakdown.projects.find((p) => p.id === "project-2");

    expect(project1!.costs).toBeCloseTo(50, 5);
    expect(project2!.costs).toBeCloseTo(50, 5);
    // The two shares must still sum back to the document's net_amount,
    // not its total_amount -- otherwise the fix would just move the
    // IVA mismatch from "which report" to "which allocation method".
    expect(project1!.costs + project2!.costs).toBeCloseTo(100, 5);
  });
});

describe("H02 -- mixed-currency documents convert into the company's own currency", () => {
  it("converts a USD sale into a CLP company's totals instead of summing it raw", async () => {
    const { computeMonthlyResult } = await import("@/lib/reporting");

    queueCompany("CLP");
    setRate("USD", "CLP", "2026-09-01", 900);

    queue("sales_documents", {
      data: [
        { net_amount: 1000, document_type: "invoice", currency: "CLP", recognized_period: null },
        { net_amount: 100, document_type: "invoice", currency: "USD", recognized_period: null },
      ],
      error: null,
    });
    queue("cost_documents", { data: [], error: null });
    queue("personnel", { data: [], error: null });

    const result = await computeMonthlyResult("company-1", "2026-09-01");

    // 1000 CLP + (100 USD x 900 CLP/USD) = 91000 CLP -- not 1100, which
    // is what summing the raw numbers regardless of currency gives.
    expect(result.netSales).toBe(91000);
    expect(result.currencyConversionPending).toBe(false);
  });

  it("excludes an amount from the total and flags it pending when no rate is available, instead of treating it as zero", async () => {
    const { computeMonthlyResult } = await import("@/lib/reporting");

    queueCompany("CLP");
    setRate("USD", "CLP", "2026-09-01", null);

    queue("sales_documents", {
      data: [
        { net_amount: 1000, document_type: "invoice", currency: "CLP", recognized_period: null },
        { net_amount: 100, document_type: "invoice", currency: "USD", recognized_period: null },
      ],
      error: null,
    });
    queue("cost_documents", { data: [], error: null });
    queue("personnel", { data: [], error: null });

    const result = await computeMonthlyResult("company-1", "2026-09-01");

    // The CLP sale still counts; the unconvertible USD one is excluded
    // (not folded in as 0 CLP, and not silently dropped without a
    // trace) -- the caller must see currencyConversionPending to know
    // netSales is incomplete, not "the real total happens to be 1000".
    expect(result.netSales).toBe(1000);
    expect(result.currencyConversionPending).toBe(true);
  });
});

describe("H02 -- getProfitabilityBreakdown converts period cost figures too", () => {
  it("converts a USD direct cost into the CLP company's project cost", async () => {
    const { getProfitabilityBreakdown } = await import("@/lib/reporting");

    queueCompany("CLP");
    setRate("USD", "CLP", "2026-09-01", 900);

    queue("sales_documents", { data: [], error: null }, { data: [], error: null });

    const directCostRow = {
      project_id: "project-1",
      total_amount: 100,
      net_amount: 100,
      currency: "USD",
    };
    queue(
      "cost_documents",
      { data: [directCostRow], error: null },
      { data: [directCostRow], error: null },
    );
    queue("cost_allocations", { data: [], error: null }, { data: [], error: null });
    queue("work_allocations", { data: [], error: null }, { data: [], error: null });

    const breakdown = await getProfitabilityBreakdown("company-1", "2026-09-01");
    const project = breakdown.projects.find((p) => p.id === "project-1");

    // 100 USD x 900 CLP/USD = 90000 CLP -- not 100.
    expect(project!.costs).toBe(90000);
    expect(breakdown.currencyConversionPending).toBe(false);
  });
});

describe("H03 -- credit notes must reduce net sales, not add to them", () => {
  it("nets an invoice against a credit note of the same amount to zero", async () => {
    const { computeMonthlyResult } = await import("@/lib/reporting");

    queueCompany("CLP");
    queue("sales_documents", {
      data: [
        { net_amount: 100, recognized_period: null, document_type: "invoice", currency: "CLP" },
        { net_amount: 100, recognized_period: null, document_type: "credit_note", currency: "CLP" },
      ],
      error: null,
    });
    queue("cost_documents", { data: [], error: null });
    queue("personnel", { data: [], error: null });

    const result = await computeMonthlyResult("company-1", "2026-09-01");

    // An invoice for 100 and a credit note for 100 against it should
    // net to zero sales, not 200 -- today document_type is never read,
    // so both are summed the same way.
    expect(result.netSales).toBe(0);
  });
});
