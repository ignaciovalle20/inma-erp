/**
 * The one helper every summary adds currencies with: per-currency subtotals
 * in their own currency, the combined total in the local currency and in
 * USD with the rate of each amount's date (that month's snapshot or the
 * nearest earlier one), and an incomplete flag instead of a guessed rate.
 */
import { describe, expect, it } from "vitest";
import {
  buildRateTable,
  combineSummaries,
  convertOn,
  negateSummary,
  summarizeMoney,
  usdPerUnitOn,
} from "@/lib/multiCurrency";

// UYU: 40 per USD in July, 42 per USD in September (no August snapshot).
const rates = buildRateTable([
  { currency: "UYU", period: "2026-09-01", ars_per_unit: 35, ars_per_usd: 1470 },
  { currency: "UYU", period: "2026-07-01", ars_per_unit: 37.5, ars_per_usd: 1500 },
  { currency: "CLP", period: "2026-09-01", ars_per_unit: 1.5, ars_per_usd: 1500 },
  { currency: "CLP", period: "2026-10-01", ars_per_unit: 0, ars_per_usd: 1500 },
]);

describe("usdPerUnitOn", () => {
  it("is 1 for USD and uses the snapshot of the date's month", () => {
    expect(usdPerUnitOn(rates, "USD", "2020-01-01")).toBe(1);
    expect(usdPerUnitOn(rates, "UYU", "2026-07-20")).toBeCloseTo(1 / 40);
    expect(usdPerUnitOn(rates, "UYU", "2026-09-02")).toBeCloseTo(1 / 42);
  });

  it("falls back to the nearest earlier snapshot, never a later one", () => {
    expect(usdPerUnitOn(rates, "UYU", "2026-08-15")).toBeCloseTo(1 / 40);
    expect(usdPerUnitOn(rates, "UYU", "2026-06-30")).toBeNull();
  });

  it("ignores snapshots with no usable rate", () => {
    expect(usdPerUnitOn(rates, "CLP", "2026-10-05")).toBeCloseTo(1 / 1000);
  });
});

describe("convertOn", () => {
  it("triangulates through USD and returns null without a rate", () => {
    expect(convertOn(rates, 1000, "CLP", "UYU", "2026-09-10")).toBeCloseTo(42);
    expect(convertOn(rates, 5, "UYU", "UYU", "1999-01-01")).toBe(5);
    expect(convertOn(rates, 5, "UYU", "USD", "2025-01-01")).toBeNull();
  });
});

describe("summarizeMoney", () => {
  it("never adds two currencies without converting", () => {
    const summary = summarizeMoney(
      [
        { amount: 100, currency: "USD", date: "2026-09-10" },
        { amount: 4200, currency: "UYU", date: "2026-09-10" },
        { amount: 800, currency: "UYU", date: "2026-07-10" },
      ],
      "UYU",
      rates,
    );
    expect(summary.byCurrency).toEqual([
      { currency: "USD", amount: 100, count: 1 },
      { currency: "UYU", amount: 5000, count: 2 },
    ]);
    // Each at the rate of its own date: 100 USD = 4.200 UYU in September.
    expect(summary.local).toBeCloseTo(4200 + 5000);
    expect(summary.usd).toBeCloseTo(100 + 100 + 20);
    expect(summary).toMatchObject({ localComplete: true, usdComplete: true });
  });

  it("uses the rate a document stores for the local total", () => {
    const summary = summarizeMoney([{ amount: 10, currency: "USD", date: "2026-09-10", rateToLocal: 41 }], "UYU", rates);
    expect(summary.local).toBe(410);
    expect(summary.usd).toBe(10);
  });

  it("leaves out what has no rate and flags the total, never 1:1", () => {
    const summary = summarizeMoney(
      [
        { amount: 1000, currency: "UYU", date: "2026-01-10" },
        { amount: 10, currency: "USD", date: "2026-01-10" },
      ],
      "UYU",
      rates,
    );
    expect(summary.local).toBe(1000);
    expect(summary.localComplete).toBe(false);
    expect(summary.usd).toBe(10);
    expect(summary.usdComplete).toBe(false);
  });
});

describe("combineSummaries", () => {
  it("subtracts per currency and keeps the incomplete flags", () => {
    const sales = summarizeMoney([{ amount: 100, currency: "USD", date: "2026-09-10" }], "UYU", rates);
    const costs = summarizeMoney([{ amount: 1000, currency: "UYU", date: "2026-01-10" }], "UYU", rates);
    const margin = combineSummaries("UYU", [{ summary: sales }, { summary: costs, sign: -1 }]);
    expect(margin.byCurrency).toEqual([
      { currency: "USD", amount: 100, count: 1 },
      { currency: "UYU", amount: -1000, count: 1 },
    ]);
    expect(margin.local).toBeCloseTo(4200 - 1000);
    expect(margin.usdComplete).toBe(false);
    expect(negateSummary(sales).usd).toBe(-100);
  });
});
