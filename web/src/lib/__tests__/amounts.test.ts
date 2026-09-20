/**
 * The generic importers used to strip every comma: "1234,5" became 12345
 * (docs/plan-sistema-v3.md, B4, H13). One parser with the CL/UY convention.
 */
import { describe, it, expect } from "vitest";
import { parseAmount, parseTaxAmount } from "@/lib/amounts";

const ok = (raw: string) => {
  const result = parseAmount(raw);
  if (result.kind !== "ok") throw new Error(`"${raw}" should parse, got ${JSON.stringify(result)}`);
  return result.value;
};

describe("parseAmount", () => {
  it.each([
    ["1234", 1234],
    ["0", 0],
    ["  86000 ", 86000],
    ["-500", -500],
    ["+500", 500],
    ["$ 1234", 1234],
  ])("reads the plain integer %j as %d", (raw, expected) => {
    expect(ok(raw)).toBe(expected);
  });

  it.each([
    ["1234,5", 1234.5],
    ["12,50", 12.5],
    ["0,5", 0.5],
    ["100,00", 100],
    ["-1234,56", -1234.56],
  ])("reads a decimal comma: %j is %d (it was ten or a hundred times too big)", (raw, expected) => {
    expect(ok(raw)).toBe(expected);
  });

  it.each([
    ["1.234", 1234],
    ["12.345", 12345],
    ["1.234.567", 1234567],
    ["999.999", 999999],
  ])("reads a dot as thousands: %j is %d", (raw, expected) => {
    expect(ok(raw)).toBe(expected);
  });

  it.each([
    ["1.234,56", 1234.56],
    ["1.234.567,89", 1234567.89],
    ["1,234.56", 1234.56],
    ["1,234,567.5", 1234567.5],
    ["12.345,6", 12345.6],
  ])("reads both separators: the last one is the decimal: %j is %d", (raw, expected) => {
    expect(ok(raw)).toBe(expected);
  });

  it.each([
    ["1234.5", 1234.5],
    ["12.50", 12.5],
    ["1234.567", 1234.567],
  ])("reads a dot with other than three digits after it as a decimal point: %j is %d", (raw, expected) => {
    expect(ok(raw)).toBe(expected);
  });

  it("reads a comma-grouped integer (several commas)", () => {
    expect(ok("1,234,567")).toBe(1234567);
  });

  it("rejects the ambiguous single comma with three digits instead of guessing", () => {
    const result = parseAmount("1,234");
    expect(result.kind).toBe("invalid");
    expect(result.kind === "invalid" && result.reason).toMatch(/ambiguo/);
    expect(parseAmount("12,345").kind).toBe("invalid");
    // ...while other comma shapes are decimals, and four digits after are not ambiguous either.
    expect(ok("1,23")).toBe(1.23);
    expect(ok("1234,567")).toBe(1234.567);
  });

  it.each(["abc", "12a", "1..2", "1,,2", "1.2.3", "1,2,3", "12.34.5,6", "1.23,456.7", ",", ".", "-", "1,", ",5", "1.", "$"])(
    "rejects %j",
    (raw) => {
      expect(parseAmount(raw).kind).toBe("invalid");
    },
  );

  it("says what was wrong, quoting the cell", () => {
    const result = parseAmount("12a");
    expect(result.kind === "invalid" && result.reason).toMatch(/"12a"/);
  });

  it("treats blank and missing cells as empty, not as zero or invalid", () => {
    for (const raw of ["", "   ", null, undefined]) {
      expect(parseAmount(raw)).toEqual({ kind: "empty" });
    }
  });
});

describe("parseTaxAmount", () => {
  it("blank tax is zero, a real tax is its value", () => {
    expect(parseTaxAmount("")).toEqual({ value: 0, error: null });
    expect(parseTaxAmount(undefined)).toEqual({ value: 0, error: null });
    expect(parseTaxAmount("16.340")).toEqual({ value: 16340, error: null });
    expect(parseTaxAmount("16340,5")).toEqual({ value: 16340.5, error: null });
  });

  it("an unreadable tax is an error to show, never a silent zero", () => {
    const result = parseTaxAmount("diecinueve");
    expect(result.value).toBeNull();
    expect(result.error).toMatch(/^IVA inválido "diecinueve"/);
    expect(parseTaxAmount("1,234").error).toMatch(/IVA inválido.*ambiguo/);
  });
});
