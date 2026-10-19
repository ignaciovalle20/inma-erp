/**
 * A document split among jobs and recurring services lands on each one for
 * its share (lib/salesAttribution.ts); Deuda / the month board count what
 * a cycle really billed and still owes (cycleMoney). And the profitability
 * breakdown, end to end with the fake client: an invoice split between two
 * jobs is no longer counted whole on the one in project_id.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { attributeSale, attributedTo, type AttributionAllocation } from "@/lib/salesAttribution";
import { cycleMoney } from "@/lib/recurringServicePending";
import { createFakeSupabase, type FakeResult } from "./fakeSupabase";

const areas = new Map<string, string | null>([
  ["job-a", "dev"],
  ["job-b", "it"],
]);

const quote = (projectId: string, amount: number): AttributionAllocation => ({
  salesDocumentId: "doc",
  amount,
  projectId,
  serviceAreaId: null,
  kind: "quote",
});

describe("attributeSale", () => {
  it("no allocation: whole on project_id, in the job's area", () => {
    expect(
      attributeSale({ amount: 1_000, documentType: "invoice", projectId: "job-a", businessAreaId: "other" }, [], areas),
    ).toEqual([{ projectId: "job-a", areaId: "dev", amount: 1_000 }]);
  });

  it("two jobs: each its share, each in its own area", () => {
    const parts = attributeSale(
      { amount: 1_000, documentType: "invoice", projectId: "job-a", businessAreaId: "dev" },
      [quote("job-a", 600), quote("job-b", 400)],
      areas,
    );
    expect(parts).toEqual([
      { projectId: "job-a", areaId: "dev", amount: 600 },
      { projectId: "job-b", areaId: "it", amount: 400 },
    ]);
    expect(attributedTo(parts, { projectId: "job-b" })).toBe(400);
    expect(attributedTo(parts, { areaId: "dev" })).toBe(600);
  });

  it("a job and a service: the service part is no job's, in the service's area; the rest stays on the document", () => {
    const parts = attributeSale(
      { amount: 1_000, documentType: "invoice", projectId: "job-a", businessAreaId: "dev" },
      [quote("job-a", 500), { salesDocumentId: "doc", amount: 300, projectId: null, serviceAreaId: "hosting", kind: "period" }],
      areas,
    );
    expect(parts).toEqual([
      { projectId: "job-a", areaId: "dev", amount: 500 },
      { projectId: null, areaId: "hosting", amount: 300 },
      { projectId: null, areaId: "dev", amount: 200 },
    ]);
    expect(parts.reduce((sum, part) => sum + part.amount, 0)).toBe(1_000);
  });

  it("a credit note is never allocated: it keeps project_id", () => {
    expect(
      attributeSale({ amount: -300, documentType: "credit_note", projectId: "job-b", businessAreaId: null }, [], areas),
    ).toEqual([{ projectId: "job-b", areaId: "it", amount: -300 }]);
  });
});

describe("cycleMoney", () => {
  it("expected while pending, billed once invoiced, only the unpaid share while owed", () => {
    expect(cycleMoney({ status: "pending_invoice", amount: 1_000, billed_amount: null })).toBe(1_000);
    expect(cycleMoney({ status: "invoiced", amount: 1_000, billed_amount: 1_200, unpaid_amount: 700 })).toBe(700);
    expect(cycleMoney({ status: "collected", amount: 1_000, billed_amount: 1_200, unpaid_amount: 0 })).toBe(1_200);
  });

  it("a cycle marked by hand, with no invoice allocated, keeps its expected amount", () => {
    expect(cycleMoney({ status: "invoiced", amount: 1_000, billed_amount: null, unpaid_amount: null })).toBe(1_000);
  });
});

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
    { id: "job-a", name: "A", client_id: "client-1", client_name: "Cliente 1", business_area_id: "dev" },
    { id: "job-b", name: "B", client_id: "client-1", client_name: "Cliente 1", business_area_id: "it" },
  ],
  getProjectCostStatus: async () => [],
}));

vi.mock("@/lib/exchangeRates", () => ({
  getOrSnapshotRate: async () => null,
  getRateTable: async () => new Map(),
  getConversionRate: async (from: string, to: string) => (from === to ? 1 : null),
}));

const ok = (data: unknown = []): FakeResult => ({ data, error: null });

describe("getProfitabilityBreakdown with a split invoice", () => {
  beforeEach(() => {
    const invoice = {
      id: "doc",
      client_id: "client-1",
      project_id: "job-a",
      business_area_id: "dev",
      net_amount: 1_000,
      document_type: "invoice",
      currency: "CLP",
      document_date: "2026-10-05",
      recognized_period: null,
    };
    fakeState.queues = {
      companies: [ok({ currency: "CLP" })],
      sales_documents: [ok([invoice]), ok([invoice])],
      cost_documents: [ok(), ok()],
      cost_allocations: [ok(), ok()],
      work_allocations: [ok(), ok()],
      recurring_service_occurrences: [ok()],
      sales_allocations: [
        ok([
          { id: "a1", sales_document_id: "doc", amount: 600, project_quotes: { project_id: "job-a" }, recurring_service_occurrences: null },
          { id: "a2", sales_document_id: "doc", amount: 400, project_quotes: { project_id: "job-b" }, recurring_service_occurrences: null },
        ]),
      ],
    };
  });

  it("each job and area gets its share; Σ areas = net sales", async () => {
    const { getProfitabilityBreakdown } = await import("@/lib/reporting");
    const breakdown = await getProfitabilityBreakdown("company-1", "2026-10-01");
    const job = (id: string) => breakdown.projects.find((p) => p.id === id)!;
    const area = (id: string) => breakdown.areas.find((a) => a.id === id)!;

    expect(job("job-a")).toMatchObject({ revenue: 600, accumulatedRevenue: 600 });
    expect(job("job-b")).toMatchObject({ revenue: 400, accumulatedRevenue: 400 });
    expect(area("dev").revenue).toBe(600);
    expect(area("it").revenue).toBe(400);
    expect(breakdown.clients[0].revenue).toBe(1_000);
  });
});
