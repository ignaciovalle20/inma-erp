/**
 * An annual recurring service is invoiced once a year: its fixed monthly cost
 * has to count twelve months against that yearly invoice, not one.
 * docs/verificacion-contable-2026-10-04.md (C03).
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

describe("getProfitabilityBreakdown -- annual recurring cost", () => {
  it("an annual service's fixed monthly cost counts twelve months against its yearly invoice", async () => {
    const { getProfitabilityBreakdown } = await import("@/lib/reporting");

    queueCompany("CLP");
    queueEmptyBaseTables();
    queue("recurring_service_occurrences", {
      data: [
        {
          amount: 120000,
          currency: "CLP",
          period: "2026-01-01",
          invoiced_at: "2026-09-08",
          invoice_due_date: "2026-09-10",
          sales_document_id: null,
          sales_documents: null,
          recurring_services: {
            client_id: "client-1",
            business_area_id: null,
            uses_cost_pool: false,
            fixed_monthly_cost: 2000,
            periodicity: "annual",
          },
          recurring_service_cost_allocations: [],
        },
      ],
      error: null,
    });

    const breakdown = await getProfitabilityBreakdown("company-1", "2026-09-01");
    const client1 = breakdown.clients.find((c) => c.id === "client-1")!;

    expect(client1.revenue).toBe(120000);
    expect(client1.costs).toBe(24000);
  });

});
