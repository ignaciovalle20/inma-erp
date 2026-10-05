/**
 * Payroll imputed to a job (work_allocations) is a cost of that job -- and
 * therefore of the job's client and area, like its direct cost documents.
 * It used to reach the job only, so a client's margin was higher than the
 * sum of its jobs' (docs/verificacion-contable-2026-10-04.md, C04).
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
  getBusinessAreas: async () => [{ id: "area-1", name: "Development" }],
  getProjects: async () => [
    { id: "p1", name: "Trabajo 1", client_id: "client-1", client_name: "Cliente 1", business_area_id: "area-1", budget: null },
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
    sales_documents: [ok(), ok()],
    cost_documents: [ok([{ project_id: "p1", total_amount: 238000, net_amount: 200000, currency: "CLP" }]), ok()],
    cost_allocations: [ok(), ok()],
    work_allocations: [ok([{ project_id: "p1", amount: 90000, personnel_costs: { currency: "CLP" } }]), ok()],
    recurring_service_occurrences: [ok()],
  };
});

describe("getProfitabilityBreakdown -- payroll imputed to a job", () => {
  it("counts for the job, its client and its area alike", async () => {
    const { getProfitabilityBreakdown } = await import("@/lib/reporting");

    const breakdown = await getProfitabilityBreakdown("company-1", "2026-09-01");

    expect(breakdown.projects.find((p) => p.id === "p1")?.costs).toBe(290000);
    expect(breakdown.clients.find((c) => c.id === "client-1")?.costs).toBe(290000);
    expect(breakdown.areas.find((a) => a.id === "area-1")?.costs).toBe(290000);
  });
});
