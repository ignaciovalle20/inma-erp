/**
 * Audit 2026-11, M-06 (golden): "Margen por área" did not add up to the
 * month. In prod, 77 Chile sales of 2026 (22.013.356 CLP, 24 % of the year)
 * have no area, job or allocation and were in no area; and the areas carry
 * general costs split to jobs (6.444.759 in 2026) that the monthly result
 * counts as general. The breakdown now returns what lands in no area and the
 * general costs the areas carry, so:
 *   Σ areas.revenue + areaUnassigned.revenue = net sales
 *   Σ areas.costs + areaUnassigned.costs = direct costs + generalCostsInAreas
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
  getBusinessAreas: async () => [{ id: "redes", name: "Redes" }],
  getProjects: async () => [
    { id: "p-redes", name: "Redes colegio", client_id: "client-1", client_name: "Cliente 1", business_area_id: "redes", budget: null, currency: "CLP" },
    { id: "p-sin-area", name: "Trabajo sin área", client_id: "client-1", client_name: "Cliente 1", business_area_id: null, budget: null, currency: "CLP" },
  ],
  getProjectCostStatus: async () => [],
}));

vi.mock("@/lib/exchangeRates", () => ({
  getOrSnapshotRate: async () => null,
  getRateTable: async () => new Map(),
  getConversionRate: async (from: string, to: string) => (from === to ? 1 : null),
}));

const ok = (data: unknown = []): FakeResult => ({ data, error: null });
const sale = (id: string, net: number, projectId: string | null, type = "invoice") => ({
  id, client_id: "client-1", project_id: projectId, business_area_id: null, net_amount: net, document_type: type, currency: "CLP",
});
const cost = (projectId: string | null, net: number) => ({
  project_id: projectId, total_amount: net * 1.19, net_amount: net, currency: "CLP", covered_by_cost_pool_id: null,
});

beforeEach(() => {
  fakeState.queues = {
    companies: [ok({ currency: "CLP" })],
    sales_documents: [
      ok([
        sale("s1", 1_000_000, "p-redes"), // Redes
        sale("s2", 500_000, null), // no area, no job: "Sin área"
        sale("s3", 200_000, "p-sin-area"), // job without area: "Sin área"
        sale("nc", 50_000, null, "credit_note"), // N/C without area: "Sin área", negative
      ]),
      ok(),
    ],
    cost_documents: [
      ok([cost("p-redes", 300_000), cost("p-sin-area", 80_000), cost(null, 10_000)]),
      ok(),
    ],
    cost_allocations: [
      ok([
        // A general invoice split 100% to the Redes job: the area's cost, a general cost in the month.
        {
          method: "percentage", percentage: 100, amount: null, client_id: null, business_area_id: null, project_id: "p-redes",
          cost_documents: { company_id: "co", classification: "general", total_amount: 119_000, net_amount: 100_000, currency: "CLP", exchange_rate: 1 },
        },
      ]),
      ok(),
    ],
    work_allocations: [
      ok([{ project_id: "p-redes", amount: 40_000, personnel_costs: { period: "2026-10-01", currency: "CLP" } }]),
      ok(),
    ],
    recurring_service_occurrences: [ok()],
  };
});

describe("getProfitabilityBreakdown -- areas against the month (M-06)", () => {
  it("returns what lands in no area and the general costs the areas carry", async () => {
    const { getProfitabilityBreakdown } = await import("@/lib/reporting");
    const breakdown = await getProfitabilityBreakdown("company-1", "2026-10-01");

    const redes = breakdown.areas.find((area) => area.id === "redes")!;
    expect(redes.revenue).toBe(1_000_000);
    expect(redes.costs).toBe(300_000 + 100_000 + 40_000);

    // Net sales 1.650.000 = Redes 1.000.000 + sin área 650.000 (500.000 + 200.000 - 50.000).
    expect(breakdown.areaUnassigned.revenue).toBe(650_000);
    // Direct costs 390.000 = Redes 300.000 + sin área 90.000 (80.000 + 10.000).
    expect(breakdown.areaUnassigned.costs).toBe(90_000);
    // The general invoice split to the job + payroll imputed to it.
    expect(breakdown.generalCostsInAreas).toBe(140_000);

    const netSales = 1_650_000;
    const directCosts = 390_000;
    expect(redes.revenue + breakdown.areaUnassigned.revenue).toBe(netSales);
    expect(redes.costs + breakdown.areaUnassigned.costs).toBe(directCosts + breakdown.generalCostsInAreas);
  });
});
