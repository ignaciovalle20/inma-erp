/**
 * The sales list opens on one month (a page with years of history and a
 * "total del mes" that adds up everything is not usable), and the totals
 * add up exactly the rows on screen.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/dal", () => ({ getSalesListRows: async () => [] }));
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

  it("adds invoiced and credit notes apart, and leaves annulled documents out", () => {
    const totals = summarizeRows([
      row({ net_amount: 1000 }),
      row({ net_amount: 500 }),
      row({ document_type: "credit_note", net_amount: 200 }),
      row({ net_amount: 999, voided: true }),
    ]);
    expect(totals).toMatchObject({ count: 3, invoiced: 1500, creditNotes: 200, net: 1300 });
  });
});
