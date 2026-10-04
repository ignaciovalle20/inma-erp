/**
 * A sale tagged with one area but belonging to a job of another area used
 * to count in BOTH areas, so Σ areas exceeded the company's net sales
 * (docs/verificacion-contable-2026-10-04.md, C07). It counts once now: under
 * its job's area when it has a job (that is where the job's costs land),
 * else under its own area.
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
  getBusinessAreas: async () => [
    { id: "dev", name: "Development" },
    { id: "it", name: "IT Support" },
  ],
  getProjects: async () => [
    { id: "p1", name: "Trabajo 1", client_id: "client-1", client_name: "Cliente 1", business_area_id: "dev", budget: null },
  ],
  getProjectCostStatus: async () => [],
}));

vi.mock("@/lib/exchangeRates", () => ({
  getOrSnapshotRate: async () => null,
  getConversionRate: async (from: string, to: string) => (from === to ? 1 : null),
}));

const ok = (data: unknown = []): FakeResult => ({ data, error: null });

beforeEach(() => {
  fakeState.queues = {
    companies: [ok({ currency: "CLP" })],
    sales_documents: [
      ok([
        // Job p1 is Development; the sale itself says IT Support.
        { id: "s1", client_id: "client-1", project_id: "p1", business_area_id: "it", net_amount: 1000000, document_type: "invoice", currency: "CLP" },
        // No job: its own area.
        { id: "s2", client_id: "client-1", project_id: null, business_area_id: "it", net_amount: 5000, document_type: "invoice", currency: "CLP" },
      ]),
      ok(),
    ],
    cost_documents: [ok(), ok()],
    cost_allocations: [ok(), ok()],
    work_allocations: [ok(), ok()],
    recurring_service_occurrences: [ok()],
  };
});

describe("getProfitabilityBreakdown -- each sale in one area", () => {
  it("counts a job's sale under the job's area only, so Σ areas = net sales", async () => {
    const { getProfitabilityBreakdown } = await import("@/lib/reporting");

    const breakdown = await getProfitabilityBreakdown("company-1", "2026-09-01");
    const revenue = (id: string) => breakdown.areas.find((a) => a.id === id)?.revenue;

    expect(revenue("dev")).toBe(1000000);
    expect(revenue("it")).toBe(5000);
    expect(breakdown.areas.reduce((sum, a) => sum + a.revenue, 0)).toBe(1005000);
  });
});
