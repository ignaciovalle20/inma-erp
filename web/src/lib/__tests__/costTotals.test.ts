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
    });
  });

  it("is plain when every document is in the company's currency", () => {
    expect(
      summarizeCostDocuments([{ classification: "general", net_amount: "1200.5", currency: "USD" }], "USD"),
    ).toEqual({ total: 1200.5, direct: 0, general: 1200.5, otherCurrencies: [] });
  });
});
