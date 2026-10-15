/**
 * The costs list's cards (Total / Directos / Generales) and its footer used
 * to add net_amount across currencies: a CLP company with a USD invoice
 * showed pesos + dollars as one figure. Each currency is added apart, and
 * the combined total converts every document with the rate of its own date
 * (docs/verificacion-contable-2026-10-04.md, C11 + multi-currency summaries).
 */
import { describe, expect, it } from "vitest";
import { summarizeCostDocuments } from "@/lib/costTotals";
import { buildRateTable } from "@/lib/multiCurrency";

// 1 USD = 1.000 CLP in September 2026.
const rates = buildRateTable([{ currency: "CLP", period: "2026-09-01", ars_per_unit: 1.5, ars_per_usd: 1500 }]);

describe("summarizeCostDocuments", () => {
  it("adds each currency apart and converts the combined total", () => {
    const totals = summarizeCostDocuments(
      [
        { classification: "direct", net_amount: 300000, currency: "CLP", document_date: "2026-09-05" },
        { classification: "general", net_amount: 100000, currency: "CLP", document_date: "2026-09-05" },
        { classification: "direct", net_amount: 250, currency: "USD", document_date: "2026-09-05", exchange_rate: 950 },
      ],
      "CLP",
      rates,
    );
    expect(totals.total.byCurrency).toEqual([
      { currency: "CLP", amount: 400000, count: 2 },
      { currency: "USD", amount: 250, count: 1 },
    ]);
    // Local: the USD invoice with its own stored rate, never 1:1.
    expect(totals.total.local).toBe(400000 + 250 * 950);
    expect(totals.total.usd).toBeCloseTo(400 + 250);
    expect(totals.direct.local).toBe(300000 + 250 * 950);
    expect(totals.general.local).toBe(100000);
  });

  it("is plain when every document is in the company's currency", () => {
    const totals = summarizeCostDocuments(
      [{ classification: "general", net_amount: "1200.5", currency: "USD", document_date: "2026-09-05" }],
      "USD",
      rates,
    );
    expect(totals.total).toMatchObject({ local: 1200.5, usd: 1200.5, localComplete: true, usdComplete: true });
    expect(totals.direct.byCurrency).toEqual([]);
  });

  // Point 5: the Microsoft invoice of a month that already has an MS pool
  // is listed, but not added (the pool already carries that cost).
  it("leaves out documents covered by an MS licenses pool and counts them apart", () => {
    const totals = summarizeCostDocuments(
      [
        { classification: "general", net_amount: 100000, currency: "CLP", document_date: "2026-09-05" },
        {
          classification: "general",
          net_amount: 50000,
          currency: "CLP",
          document_date: "2026-09-05",
          covered_by_cost_pool_id: "pool-1",
        },
      ],
      "CLP",
      rates,
    );
    expect(totals.total.local).toBe(100000);
    expect(totals.coveredByPool).toEqual({ count: 1 });
  });

  it("flags the USD total incomplete when a date has no rate at all", () => {
    const totals = summarizeCostDocuments(
      [{ classification: "direct", net_amount: 1000, currency: "CLP", document_date: "2026-08-05" }],
      "CLP",
      rates,
    );
    expect(totals.total.usdComplete).toBe(false);
    expect(totals.total.localComplete).toBe(true);
  });
});
