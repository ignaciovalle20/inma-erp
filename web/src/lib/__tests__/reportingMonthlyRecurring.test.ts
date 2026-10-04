/**
 * The monthly result (home, consolidated) and the dashboard's monthly
 * series must include recurring services exactly like the profitability
 * report does -- otherwise Σ clients never equals the monthly result
 * (docs/verificacion-contable-2026-10-04.md, C01). Same fakeSupabase
 * methodology as reportingRecurringServices.test.ts.
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
  getClients: async () => [],
  getBusinessAreas: async () => [],
  getProjects: async () => [],
  getProjectCostStatus: async () => [],
}));

vi.mock("@/lib/exchangeRates", () => ({
  getOrSnapshotRate: async () => null,
  getConversionRate: async (from: string, to: string) => (from === to ? 1 : null),
}));

function queue(table: string, ...results: FakeResult[]) {
  fakeState.queues[table] = results;
}

const ok = (data: unknown = []): FakeResult => ({ data, error: null });

/** A manually invoiced hosting cycle (revenue 50.000, fixed cost 30.000) and a
 * pooled MS cycle Nubox matched to an invoice (cost 400 only). */
const occurrences = [
  {
    amount: 50000,
    currency: "CLP",
    period: "2026-08-01",
    invoiced_at: "2026-09-03",
    invoice_due_date: "2026-09-10",
    sales_document_id: null,
    sales_documents: null,
    recurring_services: { client_id: "c1", business_area_id: null, uses_cost_pool: false, fixed_monthly_cost: 30000, periodicity: "monthly" },
    recurring_service_cost_allocations: [],
  },
  {
    amount: 1000,
    currency: "CLP",
    period: "2026-09-01",
    invoiced_at: "2026-10-01",
    invoice_due_date: "2026-09-10",
    sales_document_id: "sd-1",
    sales_documents: { document_date: "2026-09-06", recognized_period: null },
    recurring_services: { client_id: "c2", business_area_id: null, uses_cost_pool: true, fixed_monthly_cost: null, periodicity: "monthly" },
    recurring_service_cost_allocations: [{ allocated_amount: 400 }],
  },
];

// The matched invoice itself (net 1.000) is a sales document of September.
const sales = [{ net_amount: 1000, document_type: "invoice", currency: "CLP", document_date: "2026-09-06", recognized_period: null }];

beforeEach(() => {
  fakeState.queues = {};
});

describe("recurring services in the monthly result", () => {
  it("computeMonthlyResult adds the manual cycle's revenue and every cycle's cost", async () => {
    const { computeMonthlyResult } = await import("@/lib/reporting");
    queue("companies", ok({ currency: "CLP" }));
    queue("sales_documents", ok(sales));
    queue("cost_documents", ok());
    queue("personnel", ok());
    queue("recurring_service_occurrences", ok(occurrences));

    const result = await computeMonthlyResult("company-1", "2026-09-01");

    expect(result.netSales).toBe(51000); // 1.000 invoice + 50.000 manual cycle
    expect(result.directCosts).toBe(30400); // 30.000 fixed + 400 MS share
    expect(result.operatingResult).toBe(20600);
    expect(result.hasError).toBe(false);
  });

  it("getMonthlySeries (dashboard KPIs, chart, waterfall) puts them in the same month", async () => {
    const { getMonthlySeries } = await import("@/lib/reporting");
    queue("companies", ok({ currency: "CLP" }));
    queue("sales_documents", ok(sales));
    queue("cost_documents", ok());
    queue("personnel_costs", ok());
    queue("recurring_service_occurrences", ok(occurrences));

    const series = await getMonthlySeries("company-1", "2026-10-01", 2);
    const [september, october] = series;

    expect(september.netSales).toBe(51000);
    expect(september.directCosts).toBe(30400);
    expect(october.netSales).toBe(0);
    expect(october.directCosts).toBe(0);
  });

  it("a failed recurring query flags the result as incomplete instead of looking like zero", async () => {
    const { computeMonthlyResult } = await import("@/lib/reporting");
    queue("companies", ok({ currency: "CLP" }));
    queue("sales_documents", ok());
    queue("cost_documents", ok());
    queue("personnel", ok());
    queue("recurring_service_occurrences", { data: null, error: { message: "timeout" } });

    const result = await computeMonthlyResult("company-1", "2026-09-01");

    expect(result.hasError).toBe(true);
    expect(result.errors?.some((line) => line.includes("servicios recurrentes"))).toBe(true);
  });
});
