/**
 * Fixture regression tests for two confirmed findings from the
 * 2026-09-15 technical audit (H01, H03) -- written *before* either is
 * fixed, so they fail red today and prove the fix once they pass.
 * Same methodology the audit itself used in G.2: real reporting.ts
 * code, fixture rows standing in for Supabase responses, no real SQL.
 *
 * H01 -- monthly result uses net_amount (tax-excluded) everywhere, but
 * getProfitabilityBreakdown's per-project/client/area cost figures use
 * cost_documents.total_amount (tax-included) instead. A cost with
 * net 100 / IVA 19 shows as 100 in one report and 119 in the other.
 *
 * H03 -- a positive-net credit_note document is summed into net sales
 * like an invoice, instead of reducing it. Nothing in reporting.ts
 * branches on document_type at all today.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createFakeSupabase, type FakeResult } from "./fakeSupabase";

const fakeState: { queues: Record<string, FakeResult[]> } = { queues: {} };

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

vi.mock("@/lib/exchangeRates", () => ({
  getOrSnapshotRate: async () => null,
}));

function queue(table: string, ...results: FakeResult[]) {
  fakeState.queues[table] = results;
}

beforeEach(() => {
  fakeState.queues = {};
});

describe("H01 -- getProfitabilityBreakdown cost basis", () => {
  it("uses the same net (tax-excluded) basis as computeMonthlyResult, not total_amount", async () => {
    const { getProfitabilityBreakdown } = await import("@/lib/reporting");

    // sales_documents: period-scoped, then accumulated -- empty, this
    // scenario is cost-only.
    queue("sales_documents", { data: [], error: null }, { data: [], error: null });

    // cost_documents: period-scoped direct costs, then accumulated.
    // A single direct cost on project-1: net 100, IVA 19, total 119.
    const directCostRow = {
      project_id: "project-1",
      total_amount: 119,
      net_amount: 100,
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

    queue("sales_documents", { data: [], error: null }, { data: [], error: null });
    queue("cost_documents", { data: [], error: null }, { data: [], error: null });

    // A general cost document (net 100, IVA 19, total 119) split 50/50
    // by percentage across project-1 and project-2. set_cost_allocations
    // requires shares to sum to total_amount (119), so each row's gross
    // share is 59.5 -- toNetShare must scale it down to 50 (net) each,
    // not leave it at 59.5.
    const costDocuments = { total_amount: 119, net_amount: 100 };
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

describe("H03 -- credit notes must reduce net sales, not add to them", () => {
  it("nets an invoice against a credit note of the same amount to zero", async () => {
    const { computeMonthlyResult } = await import("@/lib/reporting");

    queue("sales_documents", {
      data: [
        { net_amount: 100, recognized_period: null, document_type: "invoice" },
        { net_amount: 100, recognized_period: null, document_type: "credit_note" },
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
