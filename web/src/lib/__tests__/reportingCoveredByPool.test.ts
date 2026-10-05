/**
 * The Microsoft licenses invoice of a month that already has an MS pool is
 * that pool's cost: if it is also loaded as a cost document it is marked
 * "cubierto por pool" (covered_by_cost_pool_id) and no report adds it again
 * (docs/verificacion-contable-2026-10-04.md, P08 -> point 5).
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
  getBusinessAreas: async () => [{ id: "ms", name: "Microsoft 365" }],
  getProjects: async () => [
    { id: "p1", name: "Trabajo 1", client_id: "client-1", client_name: "Cliente 1", business_area_id: "ms", quoted_amount: null, cost_budget: null, status: "cerrado" },
  ],
  getProjectCostStatus: async () => [],
}));

vi.mock("@/lib/exchangeRates", () => ({
  getOrSnapshotRate: async () => null,
  getConversionRate: async (from: string, to: string) => (from === to ? 1 : null),
}));

const ok = (data: unknown = []): FakeResult => ({ data, error: null });

const base = { currency: "CLP", exchange_rate: 1, document_date: "2026-09-15", recognized_period: null };
const costs = [
  { ...base, classification: "general", net_amount: 100_000, total_amount: 119_000, project_id: null, covered_by_cost_pool_id: null },
  // The Microsoft invoice of September, which has a pool.
  { ...base, classification: "general", net_amount: 50_000, total_amount: 59_500, project_id: null, covered_by_cost_pool_id: "pool-1" },
  { ...base, classification: "direct", net_amount: 30_000, total_amount: 35_700, project_id: "p1", covered_by_cost_pool_id: "pool-1" },
];
const allocations = [
  { method: "percentage", percentage: 100, amount: null, client_id: null, business_area_id: "ms", project_id: null, cost_documents: { total_amount: 59_500, net_amount: 50_000, currency: "CLP", exchange_rate: 1, covered_by_cost_pool_id: "pool-1" } },
];

beforeEach(() => {
  fakeState.queues = {};
});

describe("a cost document covered by an MS pool is not added again", () => {
  it("computeMonthlyResult", async () => {
    const { computeMonthlyResult } = await import("@/lib/reporting");
    fakeState.queues = {
      companies: [ok({ currency: "CLP" })],
      sales_documents: [ok()],
      cost_documents: [ok(costs)],
      personnel: [ok()],
      recurring_service_occurrences: [ok()],
    };
    const result = await computeMonthlyResult("company-1", "2026-09-01");
    expect({ direct: result.directCosts, general: result.generalCosts }).toEqual({ direct: 0, general: 100_000 });
  });

  it("getMonthlySeries", async () => {
    const { getMonthlySeries } = await import("@/lib/reporting");
    fakeState.queues = {
      companies: [ok({ currency: "CLP" })],
      sales_documents: [ok()],
      cost_documents: [ok(costs)],
      personnel_costs: [ok()],
      recurring_service_occurrences: [ok()],
    };
    const [september] = await getMonthlySeries("company-1", "2026-09-01", 1);
    expect({ direct: september.directCosts, general: september.generalCosts }).toEqual({ direct: 0, general: 100_000 });
  });

  it("getProfitabilityBreakdown (job, area, accumulated)", async () => {
    const { getProfitabilityBreakdown } = await import("@/lib/reporting");
    const direct = costs.filter((row) => row.classification === "direct");
    fakeState.queues = {
      companies: [ok({ currency: "CLP" })],
      sales_documents: [ok(), ok()],
      cost_documents: [ok(direct), ok(direct)],
      cost_allocations: [ok(allocations), ok(allocations)],
      work_allocations: [ok(), ok()],
      recurring_service_occurrences: [ok()],
    };
    const breakdown = await getProfitabilityBreakdown("company-1", "2026-09-01");
    expect(breakdown.projects.find((p) => p.id === "p1")).toMatchObject({ costs: 0, accumulatedCosts: 0 });
    expect(breakdown.areas.find((a) => a.id === "ms")?.costs).toBe(0);
  });
});
