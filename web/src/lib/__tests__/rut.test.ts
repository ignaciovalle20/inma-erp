/** The one normalization of a RUT, shared by personnel, suppliers, imports and comparisons. */
import { describe, it, expect } from "vitest";
import { normalizeRut, sameTaxId, taxIdForStorage } from "@/lib/rut";

describe("normalizeRut", () => {
  it.each([
    ["13.765.872-0", "13765872-0"],
    ["13765872-0", "13765872-0"],
    ["137658720", "13765872-0"],
    [" 13 765 872 - 0 ", "13765872-0"],
    ["9.922.443-6", "9922443-6"],
    ["09922443-6", "9922443-6"],
    ["009.922.443-6", "9922443-6"],
    ["12.345.678-k", "12345678-K"],
    ["12345678k", "12345678-K"],
  ])("%s -> %s", (input, expected) => {
    expect(normalizeRut(input)).toBe(expected);
  });

  it.each(["", "   ", "abc", "12-3-4", "1.2", "K", "1234567K8", "0000000-0", null, undefined])("rejects %s", (input) => {
    expect(normalizeRut(input as string | null | undefined)).toBeNull();
  });

  it("is idempotent", () => {
    expect(normalizeRut(normalizeRut("76.577.457-8"))).toBe("76577457-8");
  });
});

describe("taxIdForStorage", () => {
  it("stores a RUT normalized and anything else as typed, trimmed", () => {
    expect(taxIdForStorage(" 137658720 ")).toBe("13765872-0");
    expect(taxIdForStorage(" EIN 12-3 ")).toBe("EIN 12-3");
    expect(taxIdForStorage("   ")).toBeNull();
    expect(taxIdForStorage(null)).toBeNull();
  });
});

describe("sameTaxId", () => {
  it("compares by the normalized form", () => {
    expect(sameTaxId("137658720", "13.765.872-0")).toBe(true);
    expect(sameTaxId("12.345.678-k", "12345678-K")).toBe(true);
    expect(sameTaxId("13765872-0", "13765872-1")).toBe(false);
    expect(sameTaxId(null, null)).toBe(false);
    expect(sameTaxId("", "13765872-0")).toBe(false);
  });
});
