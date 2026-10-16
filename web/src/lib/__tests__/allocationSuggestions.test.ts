/**
 * Automatic allocation suggestions (lib/allocationSuggestions.ts): each rule
 * in its order of priority, the proportional split's rounding, and that a
 * suggestion counts for the documents after it. Invented data.
 */
import { describe, it, expect } from "vitest";
import {
  SUGGESTION_SUM_TOLERANCE,
  splitProportionally,
  suggestAllocationsFor,
  suggestForDocument,
  type SuggestionDocument,
  type SuggestionPeriod,
  type SuggestionQuote,
} from "@/lib/allocationSuggestions";

const doc = (overrides: Partial<SuggestionDocument> = {}): SuggestionDocument => ({
  id: "doc-1",
  clientId: "client-1",
  currency: "CLP",
  netAmount: 10_000,
  documentDate: "2026-10-05",
  documentNumber: "100",
  ...overrides,
});

const period = (overrides: Partial<SuggestionPeriod> = {}): SuggestionPeriod => ({
  id: "p-1",
  clientId: "client-1",
  currency: "CLP",
  month: "2026-10",
  expected: 10_000,
  allocated: 0,
  hasAllocations: false,
  open: true,
  ...overrides,
});

const quote = (overrides: Partial<SuggestionQuote> = {}): SuggestionQuote => ({
  id: "q-1",
  clientId: "client-1",
  currency: "CLP",
  balance: 50_000,
  ...overrides,
});

describe("1. exact", () => {
  it("one period of the month with exactly the net", () => {
    const result = suggestForDocument(doc(), [period(), period({ id: "p-2", expected: 3_000 })], []);
    expect(result).toEqual([
      { documentId: "doc-1", targetType: "period", targetId: "p-1", amount: 10_000, reason: "exact", expected: 10_000 },
    ]);
  });

  it("a quote whose balance is exactly the net", () => {
    const result = suggestForDocument(doc(), [], [quote({ balance: 10_000 }), quote({ id: "q-2", balance: 40_000 })]);
    expect(result).toMatchObject([{ targetType: "quote", targetId: "q-1", reason: "exact", amount: 10_000 }]);
  });

  it("uses what is left of a partly billed period", () => {
    const result = suggestForDocument(
      doc({ netAmount: 4_000 }),
      [period({ allocated: 6_000, hasAllocations: true }), period({ id: "p-2", expected: 9_000 })],
      [],
    );
    expect(result).toMatchObject([{ targetId: "p-1", reason: "exact", amount: 4_000, expected: 4_000 }]);
  });
});

describe("2. the only period of the month", () => {
  it("takes the whole net even when it differs from the expected amount", () => {
    const result = suggestForDocument(doc({ netAmount: 12_345 }), [period()], []);
    expect(result).toEqual([
      { documentId: "doc-1", targetType: "period", targetId: "p-1", amount: 12_345, reason: "single_period", expected: 10_000 },
    ]);
  });

  it("ignores periods of other months, clients, currencies, and closed ones", () => {
    const result = suggestForDocument(
      doc({ netAmount: 7_000 }),
      [
        period(),
        period({ id: "other-month", month: "2026-11" }),
        period({ id: "other-client", clientId: "client-2" }),
        period({ id: "other-currency", currency: "USD" }),
        period({ id: "closed", open: false }),
        period({ id: "fully-billed", allocated: 10_000, hasAllocations: true }),
      ],
      [],
    );
    expect(result).toMatchObject([{ targetId: "p-1", reason: "single_period" }]);
  });

  it("a partly billed period still counts while a material balance is left", () => {
    const partly = period({ allocated: 6_000, hasAllocations: true });
    expect(suggestForDocument(doc({ netAmount: 3_000 }), [partly], [])).toMatchObject([
      { targetId: "p-1", reason: "single_period", expected: 4_000 },
    ]);
    // 5% left is a price difference, not room for another invoice.
    const almost = period({ allocated: 9_500, hasAllocations: true });
    expect(suggestForDocument(doc({ netAmount: 3_000 }), [almost], [])).toEqual([]);
  });

  it("wins over a quote (periods come first)", () => {
    const result = suggestForDocument(doc({ netAmount: 8_000 }), [period()], [quote()]);
    expect(result).toMatchObject([{ targetType: "period", reason: "single_period" }]);
  });
});

describe("3. proportional split", () => {
  it("splits in proportion to the expected amounts when they add up within the tolerance", () => {
    // hosting 9.000 + dominio 1.000 = 10.000 expected, invoiced 10.500 (+5%).
    const result = suggestForDocument(
      doc({ netAmount: 10_500 }),
      [period({ id: "hosting", expected: 9_000 }), period({ id: "domain", expected: 1_000 })],
      [],
    );
    expect(result).toEqual([
      { documentId: "doc-1", targetType: "period", targetId: "domain", amount: 1_050, reason: "proportional", expected: 1_000 },
      { documentId: "doc-1", targetType: "period", targetId: "hosting", amount: 9_450, reason: "proportional", expected: 9_000 },
    ]);
  });

  it("the last line takes the rounding so the sum is exactly the net (CLP)", () => {
    const result = suggestForDocument(
      doc({ netAmount: 10_000 }),
      [period({ id: "a", expected: 3_333 }), period({ id: "b", expected: 3_333 }), period({ id: "c", expected: 3_334 })],
      [],
    );
    expect(result.map((r) => r.amount)).toEqual([3_333, 3_333, 3_334]);
    expect(result.reduce((sum, r) => sum + r.amount, 0)).toBe(10_000);
  });

  it("rounds to cents in USD and still adds up exactly", () => {
    const shares = splitProportionally(100, [1, 1, 1], "USD");
    expect(shares).toEqual([33.33, 33.33, 33.34]);
    expect(shares.reduce((sum, s) => sum + s, 0)).toBeCloseTo(100, 10);
  });

  it("does not suggest when the sum is outside the tolerance", () => {
    // |10.000 - 12.000| = 2.000 > 15% of 12.000 (1.800).
    const outside = 12_000;
    expect(Math.abs(10_000 - outside)).toBeGreaterThan(SUGGESTION_SUM_TOLERANCE * outside);
    const result = suggestForDocument(
      doc({ netAmount: outside }),
      [period({ id: "a", expected: 5_000 }), period({ id: "b", expected: 5_000 })],
      [quote({ balance: 1_000_000 })],
    );
    expect(result).toEqual([]);
  });

  it("accepts the edge of the tolerance", () => {
    const result = suggestForDocument(
      doc({ netAmount: 11_500 }),
      [period({ id: "a", expected: 5_000 }), period({ id: "b", expected: 5_000 })],
      [],
    );
    expect(result.map((r) => r.amount)).toEqual([5_750, 5_750]);
  });
});

describe("4. quote with balance", () => {
  it("the one quote whose balance covers the net, when the month has no period", () => {
    const result = suggestForDocument(
      doc({ netAmount: 20_000 }),
      [period({ month: "2026-09" })],
      [quote({ balance: 50_000 }), quote({ id: "q-2", balance: 5_000 }), quote({ id: "q-3", balance: null })],
    );
    expect(result).toEqual([
      { documentId: "doc-1", targetType: "quote", targetId: "q-1", amount: 20_000, reason: "quote", expected: 50_000 },
    ]);
  });

  it("two quotes that could take it: nothing", () => {
    expect(suggestForDocument(doc({ netAmount: 20_000 }), [], [quote(), quote({ id: "q-2", balance: 30_000 })])).toEqual([]);
  });

  it("a quote of another currency is not a candidate", () => {
    expect(suggestForDocument(doc({ currency: "USD", netAmount: 100 }), [], [quote()])).toEqual([]);
  });
});

describe("5. otherwise nothing", () => {
  it("no period, no quote", () => {
    expect(suggestForDocument(doc(), [], [])).toEqual([]);
  });

  it("a non-positive net", () => {
    expect(suggestForDocument(doc({ netAmount: 0 }), [period()], [])).toEqual([]);
  });
});

describe("batches", () => {
  it("a suggested period is no longer pending for the next invoice", () => {
    const result = suggestAllocationsFor(
      [doc({ id: "late", documentDate: "2026-10-20", netAmount: 9_000 }), doc({ id: "early", documentDate: "2026-10-02", netAmount: 9_500 })],
      [period()],
      [quote({ balance: 20_000 })],
    );
    // The earlier one takes the month's only period; the later one has no
    // period left, so it goes to the quote that covers it.
    expect(result).toMatchObject([
      { documentId: "early", targetId: "p-1", reason: "single_period" },
      { documentId: "late", targetId: "q-1", reason: "quote" },
    ]);
  });

  it("a quote's balance shrinks with each suggestion", () => {
    const result = suggestAllocationsFor(
      [doc({ id: "a", netAmount: 30_000 }), doc({ id: "b", documentDate: "2026-10-06", netAmount: 30_000 })],
      [],
      [quote({ balance: 50_000 })],
    );
    expect(result).toMatchObject([{ documentId: "a", targetId: "q-1" }]);
  });
});
