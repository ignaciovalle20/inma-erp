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

/**
 * The month a report opens on is the company's local month, not UTC: from
 * ~20:00/21:00 on the last day of the month the UTC month is already the next
 * one (docs/verificacion-contable-2026-10-04.md, C08).
 */
describe("currentMonth in the company's time zone", () => {
  it.each([
    // 23:30 on 30-09 in Santiago and Montevideo (both UTC-3 in October).
    ["CL", "2026-10-01T02:30:00Z", "2026-09"],
    ["UY", "2026-10-01T02:30:00Z", "2026-09"],
    // 00:30 on 01-10.
    ["CL", "2026-10-01T03:30:00Z", "2026-10"],
    ["UY", "2026-10-01T03:30:00Z", "2026-10"],
    // Chilean winter (UTC-4): 03:30Z on 01-07 is still 30-06 in Santiago,
    // already 01-07 in Montevideo.
    ["CL", "2026-07-01T03:30:00Z", "2026-06"],
    ["UY", "2026-07-01T03:30:00Z", "2026-07"],
  ])("%s at %s is %s", async (country, instant, expected) => {
    const { currentMonth } = await import("@/lib/period");
    expect(currentMonth(country, new Date(instant))).toBe(expected);
  });
});
