/**
 * plan-servicios-recurrentes.md Phase 8: getProfitabilityBreakdown
 * UNIONs recurring_service_occurrences into client/area revenue and
 * cost, without touching the trabajos (projects) figures computed
 * alongside it. Same fakeSupabase methodology as reporting.financial/
 * errors.test.ts.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { vi } from "vitest";
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
  getClients: async () => [
    { id: "client-1", name: "Cliente 1" },
    { id: "client-2", name: "Cliente 2" },
  ],
  getBusinessAreas: async () => [{ id: "area-1", name: "Microsoft 365" }],
  getProjects: async () => [],
  getProjectCostStatus: async () => [],
}));

vi.mock("@/lib/exchangeRates", () => ({
  getOrSnapshotRate: async () => null,
  getRateTable: async () => new Map(),
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

/** A recurring_service_cost_allocations row: an MS pool share, counted in the pool's month. */
function poolShare(amount: number, period: string, clientId: string, areaId: string | null) {
  return {
    allocated_amount: amount,
    currency: "CLP",
    recurring_service_cost_pools: { company_id: "company-1", period, exchange_rate: 1 },
    recurring_service_occurrences: {
      recurring_services: { client_id: clientId, business_area_id: areaId, uses_cost_pool: true },
    },
  };
}

function queueEmptyBaseTables() {
  queue("sales_documents", { data: [], error: null }, { data: [], error: null });
  queue("cost_documents", { data: [], error: null }, { data: [], error: null });
  queue("cost_allocations", { data: [], error: null }, { data: [], error: null });
  queue("work_allocations", { data: [], error: null }, { data: [], error: null });
}

beforeEach(() => {
  fakeState.queues = {};
  fakeState.rates = {};
});

describe("getProfitabilityBreakdown -- recurring services union", () => {
  it("adds a non-pooled invoiced occurrence's amount as revenue and its cost period as cost, for both its client and its area", async () => {
    const { getProfitabilityBreakdown } = await import("@/lib/reporting");

    queueCompany("CLP");
    queueEmptyBaseTables();
    queue("recurring_service_occurrences", {
      data: [
        {
          amount: 450000,
          currency: "CLP",
          invoiced_at: "2026-09-05",
          recurring_services: {
            client_id: "client-1",
            business_area_id: "area-1",
            uses_cost_pool: false,
          },
          recurring_service_cost_allocations: [],
        },
      ],
      error: null,
    });
    queue("recurring_service_cost_periods", {
      data: [
        {
          period: "2026-09-01",
          expected_amount: 50000,
          currency: "CLP",
          recurring_services: { client_id: "client-1", business_area_id: "area-1", uses_cost_pool: false },
          cost_service_allocations: [],
        },
      ],
      error: null,
    });

    const breakdown = await getProfitabilityBreakdown("company-1", "2026-09-01");
    const client1 = breakdown.clients.find((c) => c.id === "client-1")!;
    const area1 = breakdown.areas.find((a) => a.id === "area-1")!;

    expect(client1.revenue).toBe(450000);
    expect(client1.costs).toBe(50000);
    expect(client1.margin).toBe(400000);
    expect(area1.revenue).toBe(450000);
    expect(area1.costs).toBe(50000);
  });

  it("uses the cost pool's allocated_amount when uses_cost_pool is true", async () => {
    const { getProfitabilityBreakdown } = await import("@/lib/reporting");

    queueCompany("CLP");
    queueEmptyBaseTables();
    queue("recurring_service_occurrences", {
      data: [
        {
          amount: 450000,
          currency: "CLP",
          invoiced_at: "2026-09-05",
          recurring_services: {
            client_id: "client-1",
            business_area_id: null,
            uses_cost_pool: true,
          },
        },
      ],
      error: null,
    });
    queue("recurring_service_cost_allocations", {
      data: [poolShare(47368, "2026-09-01", "client-1", null)],
      error: null,
    });

    const breakdown = await getProfitabilityBreakdown("company-1", "2026-09-01");
    const client1 = breakdown.clients.find((c) => c.id === "client-1")!;

    expect(client1.costs).toBe(47368);
  });

  it("counts a pool share in the pool's month even while its sale cycle is not invoiced (fix-math 2026-11, golden)", async () => {
    // Prod, Chile 2026-11: Intcomex 1.036.626 split to Razo and TREI, both
    // cycles still pending_invoice. The supplier invoice is "cubierta por
    // pool" (left out) and the shares rode on the cycles, so the month had
    // neither: 1.036.626 of cost in no month.
    const { getProfitabilityBreakdown } = await import("@/lib/reporting");

    queueCompany("CLP");
    queueEmptyBaseTables();
    queue("recurring_service_occurrences", { data: [], error: null }); // nothing invoiced yet
    queue("recurring_service_cost_allocations", {
      data: [poolShare(580963, "2026-11-01", "client-1", "area-1"), poolShare(455663, "2026-11-01", "client-2", "area-1")],
      error: null,
    });

    const breakdown = await getProfitabilityBreakdown("company-1", "2026-11-01");
    const area1 = breakdown.areas.find((a) => a.id === "area-1")!;

    expect(breakdown.clients.find((c) => c.id === "client-1")!.costs).toBe(580963);
    expect(breakdown.clients.find((c) => c.id === "client-2")!.costs).toBe(455663);
    expect(area1.costs).toBe(1036626);
  });

  it("treats a pooled occurrence with no allocation yet as cost 0, never a guess", async () => {
    const { getProfitabilityBreakdown } = await import("@/lib/reporting");

    queueCompany("CLP");
    queueEmptyBaseTables();
    queue("recurring_service_occurrences", {
      data: [
        {
          amount: 450000,
          currency: "CLP",
          invoiced_at: "2026-09-05",
          recurring_services: {
            client_id: "client-1",
            business_area_id: null,
            uses_cost_pool: true,
          },
          recurring_service_cost_allocations: [],
        },
      ],
      error: null,
    });

    const breakdown = await getProfitabilityBreakdown("company-1", "2026-09-01");
    const client1 = breakdown.clients.find((c) => c.id === "client-1")!;

    expect(client1.revenue).toBe(450000);
    expect(client1.costs).toBe(0);
  });

  it("converts a USD occurrence into the CLP company's totals", async () => {
    const { getProfitabilityBreakdown } = await import("@/lib/reporting");

    queueCompany("CLP");
    setRate("USD", "CLP", "2026-09-01", 900);
    queueEmptyBaseTables();
    queue("recurring_service_occurrences", {
      data: [
        {
          amount: 100,
          currency: "USD",
          invoiced_at: "2026-09-05",
          recurring_services: {
            client_id: "client-1",
            business_area_id: null,
            uses_cost_pool: false,
          },
          recurring_service_cost_allocations: [],
        },
      ],
      error: null,
    });
    // Its cost period: USD 10 estimated, no stored rate -> the month's 900.
    queue("recurring_service_cost_periods", {
      data: [
        {
          period: "2026-09-01",
          expected_amount: 10,
          currency: "USD",
          recurring_services: { client_id: "client-1", business_area_id: null, uses_cost_pool: false },
          cost_service_allocations: [],
        },
      ],
      error: null,
    });

    const breakdown = await getProfitabilityBreakdown("company-1", "2026-09-01");
    const client1 = breakdown.clients.find((c) => c.id === "client-1")!;

    expect(client1.revenue).toBe(90000);
    expect(client1.costs).toBe(9000);
  });

  it("ignores an occurrence still pending_invoice -- only invoiced/collected count as revenue", async () => {
    const { getProfitabilityBreakdown } = await import("@/lib/reporting");

    queueCompany("CLP");
    queueEmptyBaseTables();
    // The query itself filters .in("status", ["invoiced", "collected"]),
    // so a real pending_invoice row would never come back here at all --
    // this queues an empty result to prove that absence, rather than
    // asserting on the SQL filter that fakeSupabase can't see.
    queue("recurring_service_occurrences", { data: [], error: null });

    const breakdown = await getProfitabilityBreakdown("company-1", "2026-09-01");
    const client1 = breakdown.clients.find((c) => c.id === "client-1")!;

    expect(client1.revenue).toBe(0);
    expect(client1.costs).toBe(0);
  });

  it("counts the cost of a cycle Nubox already matched to an invoice (in the pool's month) but not its revenue again", async () => {
    const { getProfitabilityBreakdown } = await import("@/lib/reporting");

    queueCompany("CLP");
    queueEmptyBaseTables();
    queue("recurring_service_occurrences", {
      data: [
        {
          amount: 1000,
          currency: "CLP",
          period: "2026-09-01",
          invoiced_at: "2026-10-02",
          invoice_due_date: "2026-09-10",
          sales_document_id: "sd-1",
          sales_documents: { document_date: "2026-09-06", recognized_period: null, voided: false },
          recurring_services: {
            client_id: "client-1",
            business_area_id: "area-1",
            uses_cost_pool: true,
            periodicity: "monthly",
          },
        },
      ],
      error: null,
    });
    queue("recurring_service_cost_allocations", {
      data: [poolShare(400, "2026-09-01", "client-1", "area-1")],
      error: null,
    });

    const breakdown = await getProfitabilityBreakdown("company-1", "2026-09-01");
    const client1 = breakdown.clients.find((c) => c.id === "client-1")!;
    const area1 = breakdown.areas.find((a) => a.id === "area-1")!;

    // The invoice itself (a sales_documents row) carries the revenue.
    expect(client1.revenue).toBe(0);
    expect(client1.costs).toBe(400);
    expect(area1.costs).toBe(400);
  });

  it("leaves an unrelated client's figures at zero", async () => {
    const { getProfitabilityBreakdown } = await import("@/lib/reporting");

    queueCompany("CLP");
    queueEmptyBaseTables();
    queue("recurring_service_occurrences", {
      data: [
        {
          amount: 450000,
          currency: "CLP",
          invoiced_at: "2026-09-05",
          recurring_services: {
            client_id: "client-1",
            business_area_id: null,
            uses_cost_pool: false,
          },
          recurring_service_cost_allocations: [],
        },
      ],
      error: null,
    });

    const breakdown = await getProfitabilityBreakdown("company-1", "2026-09-01");
    const client2 = breakdown.clients.find((c) => c.id === "client-2")!;

    expect(client2.revenue).toBe(0);
    expect(client2.costs).toBe(0);
  });
});
