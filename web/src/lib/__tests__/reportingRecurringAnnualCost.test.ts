/**
 * A recurring service's cost follows its own calendar -- its cost periods
 * (recurring_service_cost_periods, 20261020010000) -- whatever the sale's:
 * an annual sale is counted whole in its month, its monthly cost month by
 * month. A period counts its confirmed purchase invoices, else the fixed
 * cost (estimated). An invoice allocated to services is never also a
 * general cost. (Replaces the old "fixed monthly cost x 12 on the annual
 * invoice", docs/verificacion-contable-2026-10-04.md C03.)
 */
import { describe, it, expect, beforeEach } from "vitest";
import { vi } from "vitest";
import { createFakeSupabase, type FakeResult } from "./fakeSupabase";

const fakeState: {
  queues: Record<string, FakeResult[]>;
} = { queues: {} };

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => createFakeSupabase(fakeState.queues),
}));

vi.mock("@/lib/dal", () => ({
  getSession: async () => ({ id: "user-1" }),
  getUserCompanies: async () => [],
  getClients: async () => [
    { id: "client-1", name: "Cliente 1" },
    { id: "client-2", name: "Cliente 2" },
    { id: "client-3", name: "Cliente 3" },
  ],
  getBusinessAreas: async () => [{ id: "area-1", name: "Hosting" }],
  getProjects: async () => [],
  getProjectCostStatus: async () => [],
}));

vi.mock("@/lib/exchangeRates", () => ({
  getOrSnapshotRate: async () => null,
  getRateTable: async () => new Map(),
  getConversionRate: async (from: string, to: string) => (from === to ? 1 : null),
}));

const ok = (data: unknown = []): FakeResult => ({ data, error: null });

function queue(table: string, ...results: FakeResult[]) {
  fakeState.queues[table] = results;
}

const service = (clientId: string) => ({ client_id: clientId, business_area_id: "area-1", uses_cost_pool: false });

function costPeriod(
  clientId: string,
  period: string,
  expected: number,
  allocations: { amount: number; status: "confirmed" | "suggested" }[] = [],
) {
  return {
    period,
    expected_amount: expected,
    currency: "CLP",
    recurring_services: service(clientId),
    cost_service_allocations: allocations.map((allocation) => ({
      ...allocation,
      cost_documents: { currency: "CLP", exchange_rate: 1, document_date: period },
    })),
  };
}

function annualCycle(clientId: string, amount: number, invoicedAt: string) {
  return {
    amount,
    currency: "CLP",
    period: `${invoicedAt.slice(0, 7)}-01`,
    invoiced_at: invoicedAt,
    invoice_due_date: invoicedAt,
    sales_document_id: null,
    sales_documents: null,
    recurring_services: service(clientId),
    recurring_service_cost_allocations: [],
  };
}

function queueSeries(occurrences: unknown[], costPeriods: unknown[], costs: unknown[] = []) {
  queue("companies", ok({ currency: "CLP" }));
  queue("sales_documents", ok());
  queue("cost_documents", ok(costs));
  queue("personnel_costs", ok());
  queue("recurring_service_occurrences", ok(occurrences));
  queue("recurring_service_cost_periods", ok(costPeriods));
}

function queueMonth(occurrences: unknown[], costPeriods: unknown[], costs: unknown[] = []) {
  queue("companies", ok({ currency: "CLP" }));
  queue("sales_documents", ok());
  queue("cost_documents", ok(costs));
  queue("personnel", ok());
  queue("recurring_service_occurrences", ok(occurrences));
  queue("recurring_service_cost_periods", ok(costPeriods));
}

function queueBreakdown(occurrences: unknown[], costPeriods: unknown[]) {
  queue("companies", ok({ currency: "CLP" }));
  queue("sales_documents", ok(), ok());
  queue("cost_documents", ok(), ok());
  queue("cost_allocations", ok(), ok());
  queue("work_allocations", ok(), ok());
  queue("recurring_service_occurrences", ok(occurrences));
  queue("recurring_service_cost_periods", ok(costPeriods));
}

beforeEach(() => {
  fakeState.queues = {};
});

describe("recurring service costs by cost period", () => {
  it("Starlink sold yearly in advance with a monthly cost: the sale whole in July, the cost every month", async () => {
    const { getMonthlySeries } = await import("@/lib/reporting");
    queueSeries(
      [annualCycle("client-1", 1_200_000, "2026-07-01")],
      [
        costPeriod("client-1", "2026-07-01", 50_000),
        costPeriod("client-1", "2026-08-01", 50_000),
        costPeriod("client-1", "2026-09-01", 50_000),
      ],
    );

    const [july, august, september] = await getMonthlySeries("company-1", "2026-09-01", 3);

    expect([july.netSales, august.netSales, september.netSales]).toEqual([1_200_000, 0, 0]);
    expect([july.directCosts, august.directCosts, september.directCosts]).toEqual([50_000, 50_000, 50_000]);
    expect(july.recurringCosts).toBe(50_000);
  });

  it("a domain paid yearly: its cost only in the renewal month, never twelve times", async () => {
    const { getMonthlySeries } = await import("@/lib/reporting");
    queueSeries([annualCycle("client-1", 30_000, "2026-03-05")], [costPeriod("client-1", "2026-03-01", 12_000)]);

    const [march, april, may] = await getMonthlySeries("company-1", "2026-05-01", 3);

    expect([march.directCosts, april.directCosts, may.directCosts]).toEqual([12_000, 0, 0]);
    expect(march.netSales).toBe(30_000);
  });

  it("a period with a confirmed invoice counts the invoice; one without (or only suggested) the expected cost", async () => {
    const { getProfitabilityBreakdown } = await import("@/lib/reporting");
    const periods = [
      costPeriod("client-1", "2026-08-01", 50_000, [{ amount: 47_000, status: "confirmed" }]),
      costPeriod("client-1", "2026-09-01", 50_000, [{ amount: 49_000, status: "suggested" }]),
    ];

    queueBreakdown([], periods);
    const august = await getProfitabilityBreakdown("company-1", "2026-08-01");
    expect(august.clients.find((c) => c.id === "client-1")?.costs).toBe(47_000);
    expect(august.areas.find((a) => a.id === "area-1")?.costs).toBe(47_000);

    queueBreakdown([], periods);
    const september = await getProfitabilityBreakdown("company-1", "2026-09-01");
    expect(september.clients.find((c) => c.id === "client-1")?.costs).toBe(50_000);
  });

  it("one purchase invoice split across three hostings lands on each client, not as a general cost", async () => {
    const { computeMonthlyResult, getProfitabilityBreakdown } = await import("@/lib/reporting");
    const periods = [
      costPeriod("client-1", "2026-09-01", 100_000, [{ amount: 100_000, status: "confirmed" }]),
      costPeriod("client-2", "2026-09-01", 120_000, [{ amount: 120_000, status: "confirmed" }]),
      costPeriod("client-3", "2026-09-01", 80_000, [{ amount: 80_000, status: "confirmed" }]),
    ];
    const invoice = {
      net_amount: 300_000,
      classification: "general",
      currency: "CLP",
      exchange_rate: 1,
      document_date: "2026-09-15",
      recognized_period: null,
      service_allocated_amount: 300_000,
    };

    queueMonth([], periods, [invoice]);
    const result = await computeMonthlyResult("company-1", "2026-09-01");
    expect(result.directCosts).toBe(300_000);
    expect(result.generalCosts).toBe(0);
    expect(result.operatingResult).toBe(-300_000);

    queueBreakdown([], periods);
    const breakdown = await getProfitabilityBreakdown("company-1", "2026-09-01");
    expect(breakdown.clients.map((c) => c.costs)).toEqual([100_000, 120_000, 80_000]);
  });

  it("only the part of an invoice not allocated to services stays a general cost", async () => {
    const { computeMonthlyResult } = await import("@/lib/reporting");
    queueMonth(
      [],
      [costPeriod("client-1", "2026-09-01", 50_000, [{ amount: 60_000, status: "confirmed" }])],
      [
        {
          net_amount: 100_000,
          classification: "general",
          currency: "CLP",
          exchange_rate: 1,
          document_date: "2026-09-15",
          recognized_period: null,
          service_allocated_amount: 60_000,
        },
      ],
    );

    const result = await computeMonthlyResult("company-1", "2026-09-01");

    expect(result.directCosts).toBe(60_000);
    expect(result.generalCostDocuments).toBe(40_000);
    expect(result.directCosts + result.generalCosts).toBe(100_000);
  });
});
