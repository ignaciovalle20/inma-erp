import { describe, expect, it } from "vitest";
import { computeProjectSummary, type ProjectSummaryInput } from "@/lib/projectSummary";

function input(overrides: Partial<ProjectSummaryInput> = {}): ProjectSummaryInput {
  return {
    currency: "CLP",
    quoted: 1_000_000,
    billed: 800_000,
    costs: [],
    technicianCharges: [],
    technicianDocumentIds: new Set(),
    ...overrides,
  };
}

describe("computeProjectSummary", () => {
  it("adds costs and technicians and computes the margin over what was billed", () => {
    const summary = computeProjectSummary(
      input({
        costs: [
          { costDocumentId: "c1", currency: "CLP", amount: 200_000 },
          { costDocumentId: "c2", currency: "CLP", amount: 50_000 },
        ],
        technicianCharges: [{ costDocumentId: "t1", linkedDocumentIds: [], netAmount: 150_000, currency: "CLP" }],
      }),
    );
    expect(summary).toMatchObject({
      quoted: 1_000_000,
      billed: 800_000,
      expenses: 250_000,
      technicians: 150_000,
      margin: 400_000,
      marginPct: 50,
      excluded: [],
    });
  });

  it("counts a technician's cost documents only in Técnicos (own document and linked factura/boleta)", () => {
    const summary = computeProjectSummary(
      input({
        costs: [
          { costDocumentId: "own-doc", currency: "CLP", amount: 100_000 },
          { costDocumentId: "factura", currency: "CLP", amount: 100_000 },
          { costDocumentId: "other-tech-doc", currency: "CLP", amount: 30_000 },
          { costDocumentId: "material", currency: "CLP", amount: 40_000 },
        ],
        technicianCharges: [
          { costDocumentId: "own-doc", linkedDocumentIds: ["factura"], netAmount: 100_000, currency: "CLP" },
        ],
        technicianDocumentIds: new Set(["other-tech-doc"]),
      }),
    );
    expect(summary.expenses).toBe(40_000);
    expect(summary.technicians).toBe(100_000);
    expect(summary.margin).toBe(660_000);
  });

  it("shows no margin percentage when nothing was billed", () => {
    const summary = computeProjectSummary(
      input({ billed: 0, costs: [{ costDocumentId: "c1", currency: "CLP", amount: 10_000 }] }),
    );
    expect(summary.margin).toBe(-10_000);
    expect(summary.marginPct).toBeNull();
  });

  it("rounds the margin percentage to one decimal and keeps negatives", () => {
    const summary = computeProjectSummary(
      input({ billed: 300, currency: "USD", costs: [{ costDocumentId: "c", currency: "USD", amount: 400 }] }),
    );
    expect(summary.margin).toBe(-100);
    expect(summary.marginPct).toBe(-33.3);
  });

  it("never converts: amounts in another currency are left out and reported", () => {
    const summary = computeProjectSummary(
      input({
        currency: "USD",
        billed: 1_000,
        quoted: 1_200,
        costs: [
          { costDocumentId: "usd", currency: "USD", amount: 100.1 },
          { costDocumentId: "usd2", currency: "USD", amount: 0.2 },
          { costDocumentId: "uyu", currency: "UYU", amount: 4_000 },
        ],
        technicianCharges: [
          { costDocumentId: "t", linkedDocumentIds: [], netAmount: 8_000, currency: "UYU" },
          { costDocumentId: "t2", linkedDocumentIds: [], netAmount: 50, currency: "USD" },
        ],
      }),
    );
    expect(summary.expenses).toBe(100.3);
    expect(summary.technicians).toBe(50);
    expect(summary.margin).toBe(849.7);
    expect(summary.excluded).toEqual([
      { kind: "tecnicos", currency: "UYU", amount: 8_000 },
      { kind: "gastos", currency: "UYU", amount: 4_000 },
    ]);
  });

  it("is unknown (null), not zero, when a read failed", () => {
    const noCharges = computeProjectSummary(input({ technicianCharges: null }));
    expect(noCharges.technicians).toBeNull();
    expect(noCharges.expenses).toBeNull();
    expect(noCharges.margin).toBeNull();
    expect(noCharges.marginPct).toBeNull();

    const noCosts = computeProjectSummary(input({ costs: null }));
    expect(noCosts.expenses).toBeNull();
    expect(noCosts.technicians).toBe(0);
    expect(noCosts.margin).toBeNull();

    const noQuote = computeProjectSummary(input({ quoted: null }));
    expect(noQuote.quoted).toBeNull();
    expect(noQuote.margin).toBe(800_000);
  });
});
