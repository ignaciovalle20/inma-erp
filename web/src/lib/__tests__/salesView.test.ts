/**
 * The sales list opens on one month (a page with years of history and a
 * "total del mes" that adds up everything is not usable), and the totals
 * add up exactly the rows on screen.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/dal", () => ({
  getSalesListRows: async () => [],
  searchSalesDocuments: async () => ({ ids: [], total: 0 }),
}));
vi.mock("@/lib/reporting", async () => {
  const actual = await vi.importActual<typeof import("@/lib/reporting")>("@/lib/reporting");
  return { ...actual, getProfitabilityBreakdown: async () => ({ projects: [] }) };
});

import {
  currentMonth,
  parseSalesFilters,
  resolvePeriod,
  shiftMonth,
  summarizeRows,
  type SalesViewRow,
} from "@/app/companies/[id]/sales/salesView";
import { buildRateTable } from "@/lib/multiCurrency";

afterEach(() => {
  vi.useRealTimers();
});

describe("resolvePeriod", () => {
  it("defaults to the current month when the page is opened without a period", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-20T12:00:00Z"));
    expect(currentMonth()).toBe("2026-09");
    expect(resolvePeriod({})).toBe("2026-09");
  });

  it("shows the whole history for period=all or an empty month field", () => {
    expect(resolvePeriod({ period: "all" })).toBeNull();
    expect(resolvePeriod({ period: "" })).toBeNull();
  });

  it("uses the month asked for", () => {
    expect(resolvePeriod({ period: "2024-03" })).toBe("2024-03");
  });

  it("leaves an explicit from/to range (report drill-downs) alone", () => {
    expect(resolvePeriod({ from: "2026-01-01", to: "2026-02-01" })).toBeNull();
  });

  it("turns the month into the [start, end) range the list filters on", () => {
    const { filters } = parseSalesFilters({ period: "2026-12" });
    expect(filters.from).toBe("2026-12-01");
    expect(filters.to).toBe("2027-01-01");
    expect(parseSalesFilters({ period: "all" }).filters.from).toBeUndefined();
  });

  it("parses valid recurring filter values and marks hasActiveFilters", () => {
    const res1 = parseSalesFilters({ recurring: "recurring" });
    expect(res1.filters.recurring).toBe("recurring");
    expect(res1.hasActiveFilters).toBe(true);

    const res2 = parseSalesFilters({ recurring: "non_recurring" });
    expect(res2.filters.recurring).toBe("non_recurring");
    expect(res2.hasActiveFilters).toBe(true);
  });

  it("ignores invalid recurring filter values", () => {
    const res = parseSalesFilters({ recurring: "other" });
    expect(res.filters.recurring).toBeUndefined();
  });
});

describe("shiftMonth", () => {
  it("moves across year boundaries", () => {
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(shiftMonth("2026-09", 0)).toBe("2026-09");
  });
});

describe("summarizeRows", () => {
  const row = (overrides: Partial<SalesViewRow>): SalesViewRow =>
    ({
      document_type: "invoice",
      net_amount: 100,
      voided: false,
      cost: null,
      profit: null,
      marginPct: null,
      ...overrides,
    }) as SalesViewRow;

  // 1 USD = 40 UYU in September 2026 (and no earlier snapshot).
  const rates = buildRateTable([
    { currency: "UYU", period: "2026-09-01", ars_per_unit: 37.5, ars_per_usd: 1500 },
  ]);

  it("adds invoiced and credit notes apart, and leaves annulled documents out", () => {
    const totals = summarizeRows(
      [
        row({ net_amount: 1000, currency: "UYU", document_date: "2026-09-10" }),
        row({ net_amount: 500, currency: "UYU", document_date: "2026-09-10" }),
        row({ document_type: "credit_note", net_amount: 200, currency: "UYU", document_date: "2026-09-10" }),
        row({ net_amount: 999, voided: true, currency: "UYU", document_date: "2026-09-10" }),
      ],
      "UYU",
      rates,
    );
    expect(totals.count).toBe(3);
    expect(totals.invoiced.local).toBe(1500);
    expect(totals.creditNotes.local).toBe(200);
    expect(totals.net.local).toBe(1300);
    expect(totals.net.usd).toBeCloseTo(32.5);
  });

  // A UYU company with a USD invoice used to show "neto 2.000" (1.000 UYU +
  // 1.200 USD - 200 UYU). Each currency is added in its own currency and the
  // combined total converts every document (C10 + multi-currency summaries).
  it("adds each currency apart and converts the combined total", () => {
    const totals = summarizeRows(
      [
        row({ net_amount: 1000, currency: "UYU", document_date: "2026-09-10" }),
        row({ net_amount: 1200, currency: "USD", document_date: "2026-09-10", exchange_rate: 41 }),
        row({ document_type: "credit_note", net_amount: 200, currency: "UYU", document_date: "2026-09-10" }),
      ],
      "UYU",
      rates,
    );
    expect(totals.count).toBe(3);
    expect(totals.invoiced.byCurrency).toEqual([
      { currency: "USD", amount: 1200, count: 1 },
      { currency: "UYU", amount: 1000, count: 1 },
    ]);
    // Local: the USD invoice with its own stored rate (41), never 1:1.
    expect(totals.net.local).toBe(1000 + 1200 * 41 - 200);
    expect(totals.net.usd).toBeCloseTo(1200 + 800 / 40);
    expect(totals.net.localComplete && totals.net.usdComplete).toBe(true);
  });

  it("flags the combined total incomplete when a date has no rate at all", () => {
    const totals = summarizeRows(
      [row({ net_amount: 1000, currency: "UYU", document_date: "2026-08-10" })],
      "UYU",
      rates,
    );
    expect(totals.net.local).toBe(1000);
    expect(totals.net.usd).toBe(0);
    expect(totals.net.usdComplete).toBe(false);
  });
});
