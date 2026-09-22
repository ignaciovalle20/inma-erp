/**
 * B5 (docs/plan-sistema-v3.md, H06): a report used to log a failed query and
 * add up whatever else came back, so a normal-looking figure could be missing
 * a whole table without anything saying so. Every report now flags the failure
 * and says which query failed, and a legitimately empty month is NOT flagged.
 * Same method as reporting.financial.test.ts: real reporting.ts, queued rows
 * standing in for the API. All data invented.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createFakeSupabase, type FakeResult } from "./fakeSupabase";

const fakeState: {
  queues: Record<string, FakeResult[]>;
  projectStatusError: Error | null;
} = { queues: {}, projectStatusError: null };

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => createFakeSupabase(fakeState.queues),
}));

vi.mock("@/lib/dal", () => ({
  getSession: async () => ({ id: "user-1" }),
  getUserCompanies: async () => [],
  getClients: async () => [{ id: "client-1", name: "Cliente 1" }],
  getBusinessAreas: async () => [],
  getProjects: async () => [
    {
      id: "project-1",
      name: "Proyecto 1",
      client_id: "client-1",
      client_name: "Cliente 1",
      business_area_id: null,
      business_area_name: null,
      budget: null,
      status: "en_ejecucion",
    },
  ],
  getProjectCostStatus: async () => {
    if (fakeState.projectStatusError) throw fakeState.projectStatusError;
    return [];
  },
}));

vi.mock("@/lib/exchangeRates", () => ({
  getOrSnapshotRate: async () => null,
  getConversionRate: async () => 1,
}));

const ok = (data: unknown = []): FakeResult => ({ data, error: null });
const failure = (message: string): FakeResult => ({ data: null, error: { message } });

function queue(table: string, ...results: FakeResult[]) {
  fakeState.queues[table] = results;
}

beforeEach(() => {
  fakeState.queues = {};
  fakeState.projectStatusError = null;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

/** The queues computeMonthlyResult reads, all empty and fine. */
function monthlyQueues(overrides: Record<string, FakeResult[]> = {}) {
  queue("companies", ok({ currency: "CLP" }));
  queue("sales_documents", ok());
  queue("cost_documents", ok());
  queue("personnel", ok());
  for (const [table, results] of Object.entries(overrides)) queue(table, ...results);
}

describe("computeMonthlyResult", () => {
  it("flags a failed costs query and says which one, instead of a normal-looking figure", async () => {
    const { computeMonthlyResult } = await import("@/lib/reporting");
    monthlyQueues({ cost_documents: [failure("connection reset")] });

    const result = await computeMonthlyResult("company-1", "2026-09-01");

    expect(result.hasError).toBe(true);
    expect(result.errors).toEqual(["los costos: connection reset"]);
    expect(console.error).toHaveBeenCalled();
  });

  it("does not flag a month that is simply empty", async () => {
    const { computeMonthlyResult } = await import("@/lib/reporting");
    monthlyQueues();

    const result = await computeMonthlyResult("company-1", "2026-09-01");

    expect(result.netSales).toBe(0);
    expect(result.hasError).toBe(false);
    expect(result.errors).toEqual([]);
  });

  it("flags a company that could not be read (its currency decides every conversion)", async () => {
    const { computeMonthlyResult } = await import("@/lib/reporting");
    monthlyQueues({ companies: [failure("permission denied")] });

    const result = await computeMonthlyResult("company-1", "2026-09-01");

    expect(result.hasError).toBe(true);
    expect(result.errors).toEqual(["la empresa: permission denied"]);
  });

  it("flags a failed project cost status instead of counting every project as pending", async () => {
    const { computeMonthlyResult } = await import("@/lib/reporting");
    monthlyQueues();
    fakeState.projectStatusError = new Error("No se pudieron leer los costos de los proyectos: timeout");

    const result = await computeMonthlyResult("company-1", "2026-09-01");

    expect(result.hasError).toBe(true);
    expect(result.errors?.[0]).toMatch(/el estado de costo de los proyectos: .*timeout/);
    expect(result.pendingProjectCount).toBe(0);
  });

  it("reports every failure, not just the first", async () => {
    const { computeMonthlyResult } = await import("@/lib/reporting");
    monthlyQueues({ sales_documents: [failure("boom 1")], cost_documents: [failure("boom 2")] });

    const result = await computeMonthlyResult("company-1", "2026-09-01");

    expect(result.errors).toEqual(["las ventas: boom 1", "los costos: boom 2"]);
  });
});

describe("getMonthlySeries", () => {
  it("flags every month of the series with the same failure (the chart is drawn from one read)", async () => {
    const { getMonthlySeries } = await import("@/lib/reporting");
    queue("companies", ok({ currency: "CLP" }));
    queue("sales_documents", ok());
    queue("cost_documents", failure("statement timeout"), ok());
    queue("personnel_costs", ok());
    queue("project_cost_confirmations", ok());

    const series = await getMonthlySeries("company-1", "2026-09-01", 3);

    expect(series).toHaveLength(3);
    for (const point of series) {
      expect(point.hasError).toBe(true);
      expect(point.errors).toContain("los costos: statement timeout");
    }
  });
});

describe("computeProjectProfitability", () => {
  const projectQueues = (failedAt?: { table: string; index: number; message: string }) => {
    const tables: Record<string, FakeResult[]> = {
      sales_documents: [ok(), ok()],
      cost_documents: [ok(), ok()],
      cost_allocations: [ok(), ok()],
      work_allocations: [ok(), ok()],
    };
    if (failedAt) tables[failedAt.table][failedAt.index] = failure(failedAt.message);
    queue("projects", ok({ budget: null }));
    for (const [table, results] of Object.entries(tables)) queue(table, ...results);
  };

  it("flags a failed read of the accumulated sales: the project page had no failure flag at all", async () => {
    const { computeProjectProfitability } = await import("@/lib/reporting");
    projectQueues({ table: "sales_documents", index: 1, message: "boom" });

    const result = await computeProjectProfitability("company-1", "project-1", "2026-09-01");

    expect(result.hasError).toBe(true);
    expect(result.errors).toEqual(["las ventas acumuladas: boom"]);
  });

  it("does not flag a project with no movements", async () => {
    const { computeProjectProfitability } = await import("@/lib/reporting");
    projectQueues();

    const result = await computeProjectProfitability("company-1", "project-1", "2026-09-01");

    expect(result.accumulatedRevenue).toBe(0);
    expect(result.hasError).toBe(false);
  });
});

describe("getProfitabilityBreakdown", () => {
  it("says which reads failed, including the company", async () => {
    const { getProfitabilityBreakdown } = await import("@/lib/reporting");
    queue("companies", failure("no company"));
    queue("sales_documents", ok(), ok());
    queue("cost_documents", ok(), ok());
    queue("cost_allocations", ok(), failure("allocations down"));
    queue("work_allocations", ok(), ok());
    queue("recurring_service_occurrences", ok());

    const breakdown = await getProfitabilityBreakdown("company-1", "2026-09-01");

    expect(breakdown.hasError).toBe(true);
    expect(breakdown.errors).toEqual(["la empresa: no company", "los prorrateos acumulados: allocations down"]);
  });
});

describe("computeClientProfitability", () => {
  it("flags a failed allocations read", async () => {
    const { computeClientProfitability } = await import("@/lib/reporting");
    queue("sales_documents", ok());
    queue("projects", ok());
    queue("cost_allocations", failure("boom"));

    const result = await computeClientProfitability("company-1", "client-1", "2026-09-01");

    expect(result.hasError).toBe(true);
    expect(result.errors).toEqual(["los prorrateos: boom"]);
  });
});
