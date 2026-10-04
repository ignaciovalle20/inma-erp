/**
 * The job's own page (computeProjectProfitability) must show the same figures
 * as the profitability report and the dashboard for that job. It had its own
 * arithmetic: costs on total_amount (IVA included) instead of net, and every
 * sale added -- an unpaired credit note added revenue instead of subtracting
 * it (docs/verificacion-contable-2026-10-04.md, C02).
 *
 * The queues below serve both the old and the new implementation (same
 * tables, same order), so this test fails on the numbers, not on the fake.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabase, type FakeResult } from "./fakeSupabase";

const fakeState: { queues: Record<string, FakeResult[]> } = { queues: {} };

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => createFakeSupabase(fakeState.queues),
}));

vi.mock("@/lib/dal", () => ({
  getSession: async () => ({ id: "user-1" }),
  getUserCompanies: async () => [],
  getClients: async () => [{ id: "client-1", name: "Cliente 1" }],
  getBusinessAreas: async () => [{ id: "dev", name: "Development" }],
  getProjects: async () => [
    // Quoted for 2.000.000 (sale); 500.000 budgeted as cost (point 4 of
    // docs/verificacion-contable-2026-10-04.md: they were one column).
    { id: "p1", name: "Trabajo 1", client_id: "client-1", client_name: "Cliente 1", business_area_id: "dev", quoted_amount: 2000000, cost_budget: 500000 },
  ],
  getProjectCostStatus: async () => [],
}));

vi.mock("@/lib/exchangeRates", () => ({
  getOrSnapshotRate: async () => null,
  getConversionRate: async (from: string, to: string) => (from === to ? 1 : null),
}));

const ok = (data: unknown = []): FakeResult => ({ data, error: null });

const sales = [
  { id: "s1", client_id: "client-1", project_id: "p1", business_area_id: "dev", net_amount: 1000000, document_type: "invoice", currency: "CLP" },
  // A credit note not paired with any invoice (a discount): it subtracts.
  { id: "s2", client_id: "client-1", project_id: "p1", business_area_id: "dev", net_amount: 50000, document_type: "credit_note", currency: "CLP" },
];
// Direct cost: net 200.000 + IVA 38.000.
const directCosts = [{ project_id: "p1", total_amount: 238000, net_amount: 200000, currency: "CLP" }];
// 50% of a general cost of 119.000 (100.000 net) assigned to the job.
const allocations = [
  { method: "percentage", percentage: 50, amount: null, client_id: null, business_area_id: null, project_id: "p1", cost_documents: { total_amount: 119000, net_amount: 100000, currency: "CLP" } },
];
const work = [{ project_id: "p1", amount: 90000, personnel_costs: { currency: "CLP" } }];

beforeEach(() => {
  fakeState.queues = {
    projects: [ok({ quoted_amount: 2000000, cost_budget: 500000 })],
    companies: [ok({ currency: "CLP" })],
    sales_documents: [ok(sales), ok(sales)],
    cost_documents: [ok(directCosts), ok(directCosts)],
    cost_allocations: [ok(allocations), ok(allocations)],
    work_allocations: [ok(work), ok(work)],
    recurring_service_occurrences: [ok()],
  };
});

describe("computeProjectProfitability (the job's page)", () => {
  it("uses net amounts and subtracts credit notes, like the report", async () => {
    const { computeProjectProfitability } = await import("@/lib/reporting");

    const page = await computeProjectProfitability("company-1", "p1", "2026-09-01");

    // Revenue 1.000.000 - 50.000; costs 200.000 + 50.000 + 90.000 (all net).
    expect({ revenue: page.revenue, costs: page.costs, margin: page.margin }).toEqual({
      revenue: 950000,
      costs: 340000,
      margin: 610000,
    });
    expect(page.accumulatedRevenue).toBe(950000);
    expect(page.accumulatedCosts).toBe(340000);
    // "Vs. presupuesto" compares costs with the cost budget, never with the quote.
    expect(page.quotedAmount).toBe(2000000);
    expect(page.costBudget).toBe(500000);
    expect(page.budgetVariance).toBe(340000 - 500000);
  });
});
