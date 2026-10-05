/**
 * The MS licenses pool is entered net (without IVA); the form only shows
 * the total with IVA as a reference (docs/verificacion-contable-2026-10-04.md,
 * point 2). Chile 19%, Uruguay 22%.
 */
import { describe, expect, it } from "vitest";
import { totalWithVat, vatRateFor } from "@/lib/vat";

describe("vatRateFor", () => {
  it("is 19% in Chile and 22% in Uruguay", () => {
    expect(vatRateFor("CL")).toBe(0.19);
    expect(vatRateFor("cl")).toBe(0.19);
    expect(vatRateFor("UY")).toBe(0.22);
  });

  it("is unknown for any other country (never a guessed rate)", () => {
    expect(vatRateFor("AR")).toBeNull();
    expect(vatRateFor(null)).toBeNull();
  });
});

describe("totalWithVat", () => {
  it("adds the country's IVA to the net, rounded to the currency's decimals", () => {
    expect(totalWithVat(1_000_000, "CL", 0)).toEqual({ rate: 0.19, vat: 190_000, total: 1_190_000 });
    expect(totalWithVat(1_001, "CL", 0)).toEqual({ rate: 0.19, vat: 190, total: 1_191 });
    expect(totalWithVat(100.55, "UY", 2)).toEqual({ rate: 0.22, vat: 22.12, total: 122.67 });
  });

  it("returns null for an empty or invalid net, or an unknown country", () => {
    expect(totalWithVat(Number.NaN, "CL", 0)).toBeNull();
    expect(totalWithVat(0, "CL", 0)).toBeNull();
    expect(totalWithVat(100, "AR", 0)).toBeNull();
  });
});
