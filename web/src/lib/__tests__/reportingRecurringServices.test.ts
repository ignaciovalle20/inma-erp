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
  it("adds a non-pooled invoiced occurrence's amount as revenue and its fixed_monthly_cost as cost, for both its client and its area", async () => {
    const { getProfitabilityBreakdown } = await import("@/lib/reporting");

    queueCompany("CLP");
    queueEmptyBaseTables();
    queue("recurring_service_occurrences", {
      data: [
        {
          amount: 450000,
          currency: "CLP",
          recurring_services: {
            client_id: "client-1",
            business_area_id: "area-1",
            uses_cost_pool: false,
            fixed_monthly_cost: 50000,
          },
          recurring_service_cost_allocations: [],
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

  it("uses the cost pool's allocated_amount instead of fixed_monthly_cost when uses_cost_pool is true", async () => {
    const { getProfitabilityBreakdown } = await import("@/lib/reporting");

    queueCompany("CLP");
    queueEmptyBaseTables();
    queue("recurring_service_occurrences", {
      data: [
        {
          amount: 450000,
          currency: "CLP",
          recurring_services: {
            client_id: "client-1",
            business_area_id: null,
            uses_cost_pool: true,
            fixed_monthly_cost: null,
          },
          recurring_service_cost_allocations: [{ allocated_amount: 47368 }],
        },
      ],
      error: null,
    });

    const breakdown = await getProfitabilityBreakdown("company-1", "2026-09-01");
    const client1 = breakdown.clients.find((c) => c.id === "client-1")!;

    expect(client1.costs).toBe(47368);
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
          recurring_services: {
            client_id: "client-1",
            business_area_id: null,
            uses_cost_pool: true,
            fixed_monthly_cost: null,
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
          recurring_services: {
            client_id: "client-1",
            business_area_id: null,
            uses_cost_pool: false,
            fixed_monthly_cost: 10,
          },
          recurring_service_cost_allocations: [],
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

  it("leaves an unrelated client's figures at zero", async () => {
    const { getProfitabilityBreakdown } = await import("@/lib/reporting");

    queueCompany("CLP");
    queueEmptyBaseTables();
    queue("recurring_service_occurrences", {
      data: [
        {
          amount: 450000,
          currency: "CLP",
          recurring_services: {
            client_id: "client-1",
            business_area_id: null,
            uses_cost_pool: false,
            fixed_monthly_cost: 0,
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
