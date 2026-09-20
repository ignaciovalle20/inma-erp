/**
 * "2026-13" used to pass the month check (shape only) and then crash every
 * screen that turned it into a date.
 */
import { describe, it, expect } from "vitest";
import { isValidMonth, MONTH_PATTERN } from "@/lib/period";

describe("isValidMonth", () => {
  it.each(["2026-01", "2026-09", "2026-12", "2022-11"])("accepts %s", (value) => {
    expect(isValidMonth(value)).toBe(true);
  });

  it.each(["2026-13", "2026-00", "2026-9", "26-09", "2026-09-01", "", "septiembre"])("rejects %s", (value) => {
    expect(isValidMonth(value)).toBe(false);
  });

  it("rejects anything that is not a string", () => {
    expect(isValidMonth(undefined)).toBe(false);
    expect(isValidMonth(null)).toBe(false);
    expect(isValidMonth(202609)).toBe(false);
  });

  it("exposes the pattern the pages use directly", () => {
    expect(MONTH_PATTERN.test("2026-12")).toBe(true);
    expect(MONTH_PATTERN.test("2026-13")).toBe(false);
  });
});
