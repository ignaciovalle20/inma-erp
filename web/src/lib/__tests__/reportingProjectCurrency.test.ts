/**
 * A job in USD in a Uruguayan (UYU) company: every figure of the
 * profitability report -- per job, client and area -- is in UYU, each row
 * converted with its own rate, and the job's quote and cost budget (stored
 * in USD, projects.currency) are converted too before "Vs. presupuesto"
 * compares them with the costs. Nothing is added 1:1 across currencies.
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
    // Quoted USD 2.000, cost budget USD 500.
    { id: "p1", name: "Trabajo USD", client_id: "client-1", client_name: "Cliente 1", business_area_id: "dev", quoted_amount: 2000, cost_budget: 500, currency: "USD" },
    // A job in the local currency: its amounts stay as they are.
    { id: "p2", name: "Trabajo UYU", client_id: "client-1", client_name: "Cliente 1", business_area_id: "dev", quoted_amount: 10000, cost_budget: 3000, currency: "UYU" },
  ],
  getProjectCostStatus: async () => [],
}));

// 40 UYU per USD for the report month (the budget has no rate of its own).
vi.mock("@/lib/exchangeRates", () => ({
  getOrSnapshotRate: async () => null,
  getRateTable: async () => new Map(),
  getConversionRate: async (from: string, to: string) =>
    from === to ? 1 : from === "USD" && to === "UYU" ? 40 : null,
}));

const ok = (data: unknown = []): FakeResult => ({ data, error: null });

// An invoice of USD 1.000 at 41 (its own stored rate) and one of UYU 20.000.
const sales = [
  { id: "s1", client_id: "client-1", project_id: "p1", business_area_id: "dev", net_amount: 1000, document_type: "invoice", currency: "USD", exchange_rate: 41, document_date: "2026-11-03" },
  { id: "s2", client_id: "client-1", project_id: "p1", business_area_id: "dev", net_amount: 20000, document_type: "invoice", currency: "UYU", exchange_rate: 1, document_date: "2026-11-04" },
];
// A USD 200 cost at 41.
const directCosts = [
  { project_id: "p1", total_amount: 244, net_amount: 200, currency: "USD", exchange_rate: 41, document_date: "2026-11-05" },
];

beforeEach(() => {
  fakeState.queues = {
    companies: [ok({ currency: "UYU" })],
    sales_documents: [ok(sales), ok(sales)],
    cost_documents: [ok(directCosts), ok(directCosts)],
    cost_allocations: [ok(), ok()],
    work_allocations: [ok(), ok()],
    recurring_service_occurrences: [ok()],
  };
});

describe("profitability of a job in USD in a UYU company", () => {
  it("converts every row and the job's budget instead of adding them 1:1", async () => {
    const { getProfitabilityBreakdown } = await import("@/lib/reporting");

    const breakdown = await getProfitabilityBreakdown("company-1", "2026-11-01");
    const job = breakdown.projects.find((row) => row.id === "p1")!;

    // 1.000 × 41 + 20.000 = 61.000 (1:1 would be 21.000); cost 200 × 41.
    expect(job.revenue).toBe(61000);
    expect(job.costs).toBe(8200);
    expect(job.accumulatedRevenue).toBe(61000);
    expect(job.accumulatedCosts).toBe(8200);

    // The quote and the budget, as stored and converted at the month's 40.
    expect(job.projectCurrency).toBe("USD");
    expect(job.quotedAmountOriginal).toBe(2000);
    expect(job.costBudgetOriginal).toBe(500);
    expect(job.quotedAmount).toBe(80000);
    expect(job.costBudget).toBe(20000);
    expect(job.budgetVariance).toBe(8200 - 20000);

    // The client and the area add the same converted figures.
    expect(breakdown.clients[0]).toMatchObject({ revenue: 61000, costs: 8200 });
    expect(breakdown.areas[0]).toMatchObject({ revenue: 61000, costs: 8200 });
    expect(breakdown.currencyConversionPending).toBe(false);
  });

  it("keeps a job in the local currency as is", async () => {
    const { getProfitabilityBreakdown } = await import("@/lib/reporting");

    const breakdown = await getProfitabilityBreakdown("company-1", "2026-11-01");
    const job = breakdown.projects.find((row) => row.id === "p2")!;

    expect(job).toMatchObject({ projectCurrency: "UYU", quotedAmount: 10000, costBudget: 3000, budgetVariance: -3000 });
  });

  it("leaves the budget out (not 0) and flags the report when the month has no rate", async () => {
    const rates = await import("@/lib/exchangeRates");
    vi.spyOn(rates, "getConversionRate").mockImplementation(async (from, to) => (from === to ? 1 : null));
    const { getProfitabilityBreakdown } = await import("@/lib/reporting");

    const breakdown = await getProfitabilityBreakdown("company-1", "2026-11-01");
    const job = breakdown.projects.find((row) => row.id === "p1")!;

    expect(job.costBudget).toBeNull();
    expect(job.budgetVariance).toBeNull();
    expect(breakdown.currencyConversionPending).toBe(true);
  });
});
