import { describe, expect, it } from "vitest";
import {
  derivedPercentage,
  fillRemainder,
  resolveAmounts,
  resolvedTotals,
  serviceGrossAmounts,
  splitEvenly,
  type AllocationRow,
} from "../allocations";

const TOTAL = 2554993;
const pct = (value: string): AllocationRow => ({ method: "percentage", value });
const amount = (value: string): AllocationRow => ({ method: "fixed_amount", value });

describe("resolveAmounts", () => {
  it("resolves a percentage row from the typed percentage, in whole pesos", () => {
    // 2.554.993 x 78,28% = 2.000.048,52 -> 2.000.049
    expect(resolveAmounts([pct("78.28"), amount("554944")], TOTAL, 0)).toEqual([2000049, 554944]);
  });

  it("case 1: 78,28% plus an amount of 554.944 adds up to the total", () => {
    const rows = [pct("78.28"), amount("554944")];
    expect(resolvedTotals(rows, TOTAL, 0)).toMatchObject({ assigned: TOTAL, missing: 0, matches: true });
    expect(derivedPercentage(554944, TOTAL, 0)).toBe("21.72");
  });

  it("puts the rounding residue of percentage rows on the last one", () => {
    // Each third rounds to 851.664, one peso short of the total.
    const rows = [pct("33.333333"), pct("33.333333"), pct("33.333334")];
    const amounts = resolveAmounts(rows, TOTAL, 0);
    expect(amounts.reduce((sum, value) => sum + value, 0)).toBe(TOTAL);
    expect(amounts[2]).toBe(TOTAL - amounts[0] - amounts[1]);
  });

  it("never adjusts an amount row, nor a real gap", () => {
    expect(resolveAmounts([amount("1000"), amount("2000")], 3001, 0)).toEqual([1000, 2000]);
    // 78,27% leaves 256 pesos missing: that's not rounding.
    expect(resolvedTotals([pct("78.27"), amount("554944")], TOTAL, 0).missing).toBe(256);
  });

  it("works in cents for a currency with decimals", () => {
    // Both halves round 50,005 up; the last row gives the extra cent back.
    expect(resolveAmounts([pct("50"), pct("50")], 100.01, 2)).toEqual([5001, 5000]);
  });
});

describe("resolvedTotals", () => {
  it("case 3: an amount above the total is over, by how much", () => {
    const totals = resolvedTotals([amount("3000000"), amount("")], TOTAL, 0);
    expect(totals).toMatchObject({ matches: false, over: true, missing: -445007 });
  });
});

describe("splitEvenly", () => {
  it("case 2: three equal parts in whole pesos, residue on the last row", () => {
    const rows = splitEvenly([pct(""), pct(""), pct("")], TOTAL, 0);
    expect(rows.map((row) => row.value)).toEqual(["851664", "851664", "851665"]);
    expect(rows.every((row) => row.method === "fixed_amount")).toBe(true);
    expect(resolvedTotals(rows, TOTAL, 0).matches).toBe(true);
  });
});

describe("fillRemainder", () => {
  it("puts the exact missing amount on the chosen row", () => {
    const rows = fillRemainder([pct("78.28"), amount("")], 1, TOTAL, 0);
    expect(rows[1]).toEqual({ method: "fixed_amount", value: "554944" });
    expect(resolvedTotals(rows, TOTAL, 0).matches).toBe(true);
  });

  it("leaves the rows alone when nothing is missing or they already went over", () => {
    const over = [amount("3000000"), amount("")];
    expect(fillRemainder(over, 1, TOTAL, 0)).toBe(over);
  });
});

describe("serviceGrossAmounts", () => {
  it("keeps the gross saved from Editar asignación", () => {
    expect(serviceGrossAmounts([{ amount: 84034, grossAmount: 100000 }], 1_000_000, 1_190_000, 0)).toEqual([100000]);
  });

  it("grosses up a net saved from Asignar a servicios", () => {
    // 10.000 net of a 100.000 + 19% invoice is 11.900 of its total.
    expect(serviceGrossAmounts([{ amount: 10000, grossAmount: null }], 100_000, 119_000, 0)).toEqual([11900]);
  });

  it("adds up to the total when the services take the whole net", () => {
    // Three thirds of 100.001 net / 119.001 total: the last one takes the rounding.
    const gross = serviceGrossAmounts(
      [
        { amount: 33334, grossAmount: null },
        { amount: 33334, grossAmount: null },
        { amount: 33333, grossAmount: null },
      ],
      100_001,
      119_001,
      0,
    );
    expect(gross.reduce((sum, value) => sum + value, 0)).toBe(119_001);
  });
});
