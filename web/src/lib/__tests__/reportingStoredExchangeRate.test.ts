/**
 * Every document keeps the exchange rate of its own date (exchange_rate:
 * company-currency units per unit of the document's currency, stored when
 * it is created or imported), and every report converts with that stored
 * rate -- never with whatever the month's snapshot says today, which used to
 * be rewritten each time someone opened a report of the current month
 * (docs/verificacion-contable-2026-10-04.md, P03 -> point 3).
 *
 * Here the month's rate (getConversionRate) says 1.000 CLP per USD while the
 * documents stored 900 (sale), 950 (cost), 800 (recurring cycle) and 850 (MS
 * pool). A row without a stored rate (created before this change and not
 * backfilled) still falls back to the month's rate.
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
    { id: "p1", name: "Trabajo 1", client_id: "client-1", client_name: "Cliente 1", business_area_id: "dev", budget: null, status: "cerrado" },
  ],
  getProjectCostStatus: async () => [],
}));

vi.mock("@/lib/exchangeRates", () => ({
  getOrSnapshotRate: async () => null,
  // The month's rate today: 1 USD = 1.000 CLP.
  getConversionRate: async (from: string, to: string) => (from === to ? 1 : from === "USD" && to === "CLP" ? 1000 : null),
}));

const ok = (data: unknown = []): FakeResult => ({ data, error: null });

const sales = [
  // USD 100 at the stored 900 = 90.000.
  { id: "s1", client_id: "client-1", project_id: "p1", business_area_id: "dev", net_amount: 100, document_type: "invoice", currency: "USD", exchange_rate: 900, document_date: "2026-09-10", recognized_period: null },
  // USD 10 with no stored rate: the month's 1.000 = 10.000.
  { id: "s2", client_id: "client-1", project_id: null, business_area_id: "dev", net_amount: 10, document_type: "invoice", currency: "USD", exchange_rate: null, document_date: "2026-09-11", recognized_period: null },
];
// General cost USD 20 at the stored 950 = 19.000.
const costs = [{ project_id: null, net_amount: 20, total_amount: 24, classification: "general", currency: "USD", exchange_rate: 950, document_date: "2026-09-12", recognized_period: null }];
// A hosting cycle billed in USD 10 (stored 800 = 8.000), fixed cost USD 4
// (3.200), and an MS cycle whose pool share is USD 2 at the pool's 850 = 1.700.
const occurrences = [
  {
    amount: 10,
    currency: "USD",
    exchange_rate: 800,
    period: "2026-09-01",
    invoiced_at: "2026-09-03",
    invoice_due_date: "2026-09-10",
    sales_document_id: null,
    sales_documents: null,
    recurring_services: { client_id: "client-1", business_area_id: "dev", uses_cost_pool: false, fixed_monthly_cost: 4, periodicity: "monthly" },
    recurring_service_cost_allocations: [],
  },
  {
    amount: 0,
    currency: "USD",
    exchange_rate: 800,
    period: "2026-09-01",
    invoiced_at: "2026-09-03",
    invoice_due_date: "2026-09-10",
    sales_document_id: null,
    sales_documents: null,
    recurring_services: { client_id: "client-1", business_area_id: "dev", uses_cost_pool: true, fixed_monthly_cost: null, periodicity: "monthly" },
    recurring_service_cost_allocations: [
      { allocated_amount: 2, currency: "USD", recurring_service_cost_pools: { exchange_rate: 850 } },
    ],
  },
];

// By hand: sales 90.000 + 10.000 + recurring 8.000 = 108.000;
// direct (recurring) 3.200 + 1.700 = 4.900; general 19.000.
const EXPECTED = { netSales: 108_000, directCosts: 4_900, generalCosts: 19_000, operatingResult: 84_100 };

beforeEach(() => {
  fakeState.queues = {};
});

describe("reports convert with the rate stored on each document", () => {
  it("computeMonthlyResult (home, consolidated)", async () => {
    const { computeMonthlyResult } = await import("@/lib/reporting");
    fakeState.queues = {
      companies: [ok({ currency: "CLP" })],
      sales_documents: [ok(sales)],
      cost_documents: [ok(costs)],
      personnel: [ok()],
      recurring_service_occurrences: [ok(occurrences)],
    };

    const result = await computeMonthlyResult("company-1", "2026-09-01");

    expect({
      netSales: result.netSales,
      directCosts: result.directCosts,
      generalCosts: result.generalCosts,
      operatingResult: result.operatingResult,
    }).toEqual(EXPECTED);
    expect(result.currencyConversionPending).toBe(false);
  });

  it("getMonthlySeries (dashboard)", async () => {
    const { getMonthlySeries } = await import("@/lib/reporting");
    fakeState.queues = {
      companies: [ok({ currency: "CLP" })],
      sales_documents: [ok(sales)],
      cost_documents: [ok(costs)],
      personnel_costs: [ok()],
      recurring_service_occurrences: [ok(occurrences)],
    };

    const [september] = await getMonthlySeries("company-1", "2026-09-01", 1);

    expect({
      netSales: september.netSales,
      directCosts: september.directCosts,
      generalCosts: september.generalCosts,
      operatingResult: september.operatingResult,
    }).toEqual(EXPECTED);
  });

  it("getProfitabilityBreakdown (clients, jobs, areas)", async () => {
    const { getProfitabilityBreakdown } = await import("@/lib/reporting");
    fakeState.queues = {
      companies: [ok({ currency: "CLP" })],
      sales_documents: [ok(sales), ok([])],
      cost_documents: [ok([]), ok([])],
      cost_allocations: [ok([]), ok([])],
      work_allocations: [ok([]), ok([])],
      recurring_service_occurrences: [ok(occurrences)],
    };

    const breakdown = await getProfitabilityBreakdown("company-1", "2026-09-01");

    expect(breakdown.projects.find((p) => p.id === "p1")?.revenue).toBe(90_000);
    // Client: 90.000 + 10.000 + 8.000 revenue; 4.900 recurring costs.
    const client = breakdown.clients.find((c) => c.id === "client-1");
    expect({ revenue: client?.revenue, costs: client?.costs }).toEqual({ revenue: 108_000, costs: 4_900 });
  });

  // Point 4: the job's life-to-date figures (and the dashboard's
  // "Vs. presupuesto") are in the company's currency too.
  it("accumulated job figures convert each row: stored rate, else its own month's", async () => {
    const { getProfitabilityBreakdown } = await import("@/lib/reporting");
    const accumulatedSales = [
      { project_id: "p1", net_amount: 100, document_type: "invoice", currency: "USD", exchange_rate: 900, document_date: "2025-01-10", recognized_period: null },
      { project_id: "p1", net_amount: 50_000, document_type: "invoice", currency: "CLP", exchange_rate: 1, document_date: "2025-02-10", recognized_period: null },
    ];
    const accumulatedCosts = [
      // No stored rate: its own month (2025-03), 1.000.
      { project_id: "p1", net_amount: 10, total_amount: 12, currency: "USD", exchange_rate: null, document_date: "2025-03-10", recognized_period: null },
    ];
    const accumulatedAllocations = [
      { method: "amount", percentage: null, amount: 119, client_id: null, business_area_id: null, project_id: "p1", cost_documents: { total_amount: 119, net_amount: 100, currency: "USD", exchange_rate: 950, document_date: "2025-04-01", recognized_period: null } },
    ];
    const accumulatedWork = [{ project_id: "p1", amount: 20_000, personnel_costs: { period: "2025-05-01", currency: "CLP" } }];
    fakeState.queues = {
      companies: [ok({ currency: "CLP" })],
      sales_documents: [ok([]), ok(accumulatedSales)],
      cost_documents: [ok([]), ok(accumulatedCosts)],
      cost_allocations: [ok([]), ok(accumulatedAllocations)],
      work_allocations: [ok([]), ok(accumulatedWork)],
      recurring_service_occurrences: [ok([])],
    };

    const breakdown = await getProfitabilityBreakdown("company-1", "2026-09-01");
    const job = breakdown.projects.find((p) => p.id === "p1");

    // Revenue 100 x 900 + 50.000; costs 10 x 1.000 + 100 x 950 + 20.000.
    expect(job?.accumulatedRevenue).toBe(140_000);
    expect(job?.accumulatedCosts).toBe(125_000);
    expect(job?.accumulatedMargin).toBe(15_000);
  });
});
