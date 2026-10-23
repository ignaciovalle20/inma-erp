/**
 * Purchase invoices -> recurring service cost periods
 * (lib/costAllocationSuggestions.ts): each rule in its order, the largest
 * remainder split, and what is left unallocated. Invented data.
 */
import { describe, it, expect } from "vitest";
import {
  proposeCostAllocations,
  splitByLargestRemainder,
  type CostCandidateDocument,
  type CostCandidatePeriod,
} from "@/lib/costAllocationSuggestions";

const doc = (overrides: Partial<CostCandidateDocument> = {}): CostCandidateDocument => ({
  id: "d1",
  supplierId: "starlink",
  currency: "CLP",
  netAmount: 50_000,
  month: "2026-10",
  documentDate: "2026-10-03",
  ...overrides,
});

const period = (overrides: Partial<CostCandidatePeriod> = {}): CostCandidatePeriod => ({
  id: "p1",
  supplierId: "starlink",
  currency: "CLP",
  month: "2026-10",
  expected: 50_000,
  serviceName: "Antena A",
  ...overrides,
});

describe("1. exact", () => {
  it("one document, one period of the same amount: confirmed", () => {
    expect(proposeCostAllocations([doc()], [period(), period({ id: "p2", expected: 10_000, serviceName: "B" })])).toEqual([
      { documentId: "d1", costPeriodId: "p1", amount: 50_000, status: "confirmed", reason: "exact" },
    ]);
  });

  it("never across suppliers, months or currencies", () => {
    expect(
      proposeCostAllocations(
        [doc()],
        [
          period({ id: "x1", supplierId: "other" }),
          period({ id: "x2", month: "2026-09" }),
          period({ id: "x3", currency: "USD" }),
        ],
      ),
    ).toEqual([]);
  });
});

describe("2. same amount batch", () => {
  it("4 equal invoices and 4 services: paired in stable order, confirmed", () => {
    const documents = [
      doc({ id: "d4", documentDate: "2026-10-04" }),
      doc({ id: "d1", documentDate: "2026-10-01" }),
      doc({ id: "d3", documentDate: "2026-10-03" }),
      doc({ id: "d2", documentDate: "2026-10-02" }),
    ];
    const periods = [
      period({ id: "pc", serviceName: "Antena C" }),
      period({ id: "pa", serviceName: "Antena A" }),
      period({ id: "pd", serviceName: "Antena D" }),
      period({ id: "pb", serviceName: "Antena B" }),
    ];
    expect(proposeCostAllocations(documents, periods)).toEqual([
      { documentId: "d1", costPeriodId: "pa", amount: 50_000, status: "confirmed", reason: "same_amount_batch" },
      { documentId: "d2", costPeriodId: "pb", amount: 50_000, status: "confirmed", reason: "same_amount_batch" },
      { documentId: "d3", costPeriodId: "pc", amount: 50_000, status: "confirmed", reason: "same_amount_batch" },
      { documentId: "d4", costPeriodId: "pd", amount: 50_000, status: "confirmed", reason: "same_amount_batch" },
    ]);
  });

  it("more invoices than services: pairs what it can, the rest stays unallocated (no suggestion)", () => {
    const result = proposeCostAllocations(
      [doc({ id: "d1" }), doc({ id: "d2", documentDate: "2026-10-04" }), doc({ id: "d3", documentDate: "2026-10-05" })],
      [period({ id: "pa" }), period({ id: "pb", serviceName: "Antena B" })],
    );
    expect(result.map((r) => [r.documentId, r.costPeriodId, r.status])).toEqual([
      ["d1", "pa", "confirmed"],
      ["d2", "pb", "confirmed"],
    ]);
  });
});

describe("3. proportional", () => {
  const hostings = [
    period({ id: "h1", supplierId: "server", expected: 10_000, serviceName: "Hosting 1" }),
    period({ id: "h2", supplierId: "server", expected: 20_000, serviceName: "Hosting 2" }),
    period({ id: "h3", supplierId: "server", expected: 30_000, serviceName: "Hosting 3" }),
  ];

  it("one invoice equal to the sum of every period of the supplier: split and confirmed", () => {
    expect(proposeCostAllocations([doc({ supplierId: "server", netAmount: 60_000 })], hostings)).toEqual([
      { documentId: "d1", costPeriodId: "h1", amount: 10_000, status: "confirmed", reason: "proportional" },
      { documentId: "d1", costPeriodId: "h2", amount: 20_000, status: "confirmed", reason: "proportional" },
      { documentId: "d1", costPeriodId: "h3", amount: 30_000, status: "confirmed", reason: "proportional" },
    ]);
  });

  it("the supplier's only invoice of the month that does not add up: the same split, only suggested", () => {
    const result = proposeCostAllocations([doc({ supplierId: "server", netAmount: 66_000 })], hostings);
    expect(result.map((r) => [r.costPeriodId, r.amount, r.status])).toEqual([
      ["h1", 11_000, "suggested"],
      ["h2", 22_000, "suggested"],
      ["h3", 33_000, "suggested"],
    ]);
  });

  it("two invoices that do not add up: nothing", () => {
    expect(
      proposeCostAllocations(
        [doc({ supplierId: "server", netAmount: 25_000 }), doc({ id: "d2", supplierId: "server", netAmount: 26_000 })],
        hostings,
      ),
    ).toEqual([]);
  });

  it("an exact match comes first; the proportional rule takes the periods that are left", () => {
    const result = proposeCostAllocations(
      [doc({ supplierId: "server", netAmount: 30_000 }), doc({ id: "d2", supplierId: "server", netAmount: 30_000, documentDate: "2026-10-09" })],
      hostings,
    );
    // d1 = Hosting 3 (exact). d2 = 30.000 = Hosting 1 + Hosting 2.
    expect(result.map((r) => [r.documentId, r.costPeriodId, r.amount, r.reason])).toEqual([
      ["d1", "h3", 30_000, "same_amount_batch"],
      ["d2", "h1", 10_000, "proportional"],
      ["d2", "h2", 20_000, "proportional"],
    ]);
  });
});

describe("splitByLargestRemainder", () => {
  it("whole pesos that add up exactly, the rest to the largest fractions", () => {
    const shares = splitByLargestRemainder(100, [1, 1, 1], "CLP");
    expect(shares).toEqual([34, 33, 33]);
    expect(shares.reduce((s, v) => s + v, 0)).toBe(100);
  });

  it("cents in USD", () => {
    const shares = splitByLargestRemainder(100, [1, 1, 1], "USD");
    expect(shares).toEqual([33.34, 33.33, 33.33]);
    expect(Math.round(shares.reduce((s, v) => s + v, 0) * 100)).toBe(10_000);
  });

  it("all weights zero split equally", () => {
    expect(splitByLargestRemainder(10, [0, 0], "CLP")).toEqual([5, 5]);
  });
});
