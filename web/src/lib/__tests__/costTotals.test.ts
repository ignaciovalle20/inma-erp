/**
 * The costs list's cards (Total / Directos / Generales) and its footer used
 * to add net_amount across currencies: a CLP company with a USD invoice
 * showed pesos + dollars as one figure. Only the company's currency is
 * added; other currencies are reported apart
 * (docs/verificacion-contable-2026-10-04.md, C11).
 */
import { describe, expect, it } from "vitest";
import { summarizeCostDocuments } from "@/lib/costTotals";

describe("summarizeCostDocuments", () => {
  it("adds only the company's currency and lists the rest per currency", () => {
    const totals = summarizeCostDocuments(
      [
        { classification: "direct", net_amount: 300000, currency: "CLP" },
        { classification: "general", net_amount: 100000, currency: "CLP" },
        { classification: "direct", net_amount: 250, currency: "USD" },
      ],
      "CLP",
    );
    expect(totals).toEqual({
      total: 400000,
      direct: 300000,
      general: 100000,
      otherCurrencies: [{ currency: "USD", count: 1, net: 250 }],
      coveredByPool: { count: 0, net: 0 },
    });
  });

  it("is plain when every document is in the company's currency", () => {
    expect(
      summarizeCostDocuments([{ classification: "general", net_amount: "1200.5", currency: "USD" }], "USD"),
    ).toMatchObject({ total: 1200.5, direct: 0, general: 1200.5, otherCurrencies: [] });
  });

  // Point 5: the Microsoft invoice of a month that already has an MS pool
  // is listed, but not added (the pool already carries that cost).
  it("leaves out documents covered by an MS licenses pool and counts them apart", () => {
    const totals = summarizeCostDocuments(
      [
        { classification: "general", net_amount: 100000, currency: "CLP" },
        { classification: "general", net_amount: 50000, currency: "CLP", covered_by_cost_pool_id: "pool-1" },
      ],
      "CLP",
    );
    expect(totals).toEqual({
      total: 100000,
      direct: 0,
      general: 100000,
      otherCurrencies: [],
      coveredByPool: { count: 1, net: 50000 },
    });
  });
});
