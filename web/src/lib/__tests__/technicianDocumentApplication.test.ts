import { describe, expect, it } from "vitest";
import {
  applicationCheck,
  backedChargeAmounts,
  chargeAmountLines,
  conversionEntryMode,
  parseApplied,
  payableOfApplied,
} from "../technicians";

// FAC-EL 257 of Luis Fuentes Catrin E.I.R.L.: neto 2.147.053, IVA 407.940, total 2.554.993.
const NET = 2147053;
const TOTAL = 2554993;

function fromTotal(total: number) {
  return backedChargeAmounts({ backing: "factura", enteredAs: "total", value: total, withholdingRate: null })!;
}

describe("the amounts of a factura charge agreed with IVA", () => {
  it("Redes: 2.000.000 with IVA is 1.680.672 net", () => {
    expect(fromTotal(2_000_000)).toMatchObject({ cost: 1_680_672, payable: 2_000_000, vat: 319_328 });
  });

  it("the four jobs of the FAC-EL 257 add up to its net within the rounding", () => {
    const costs = [2_000_000, 400_000, 45_000, 109_993].map((total) => fromTotal(total).cost);
    expect(costs).toEqual([1_680_672, 336_134, 37_815, 92_431]);
    expect(applicationCheck(costs, NET)).toEqual({ sum: 2_147_052, difference: 1, matches: true });
  });

  it("agreed net: the IVA goes on top and the cost is the net", () => {
    expect(backedChargeAmounts({ backing: "factura", enteredAs: "net", value: 1_680_672, withholdingRate: null })).toMatchObject({
      cost: 1_680_672,
      vat: 319_328,
      payable: 2_000_000,
    });
  });
});

describe("chargeAmountLines says what each amount is", () => {
  it("factura: Neto / IVA / Total a pagar", () => {
    expect(chargeAmountLines({ backing: "factura", amount: 2_000_000, net_amount: 1_680_672 })).toEqual([
      { label: "Neto", value: 1_680_672 },
      { label: "IVA", value: 319_328 },
      { label: "Total a pagar", value: 2_000_000 },
    ]);
  });

  it("boleta: Bruto / Retención / Líquido a pagar", () => {
    expect(chargeAmountLines({ backing: "boleta", amount: 500_000, net_amount: 589_970 })).toEqual([
      { label: "Bruto", value: 589_970 },
      { label: "Retención", value: 89_970 },
      { label: "Líquido a pagar", value: 500_000 },
    ]);
  });

  it("without backing, what is loaded is what is paid", () => {
    expect(chargeAmountLines({ backing: "none", amount: 210_000, net_amount: 210_000 })).toEqual([
      { label: "A pagar", value: 210_000 },
    ]);
  });
});

describe("applicationCheck compares net with net", () => {
  it("is never against the total with IVA", () => {
    expect(applicationCheck([NET], TOTAL).matches).toBe(false);
    expect(applicationCheck([NET], NET)).toEqual({ sum: NET, difference: 0, matches: true });
  });

  it("gives the sum and the difference of what is selected", () => {
    expect(applicationCheck([1_680_672], NET)).toEqual({ sum: 1_680_672, difference: 466_381, matches: false });
  });

  it("is negative when the charges go over the document", () => {
    expect(applicationCheck([NET, 100], NET)).toEqual({ sum: NET + 100, difference: -100, matches: false });
  });

  it("allows 1 peso of rounding per charge, no more", () => {
    expect(applicationCheck([50, 50], 102).matches).toBe(true);
    expect(applicationCheck([50, 50], 103).matches).toBe(false);
  });

  it("nothing selected does not match", () => {
    expect(applicationCheck([], 0).matches).toBe(false);
  });
});

describe("a boleta stays bruto with bruto", () => {
  it("the bruto is what is reconciled, the líquido what is paid", () => {
    const amounts = backedChargeAmounts({ backing: "boleta", enteredAs: "liquid", value: 500_000, withholdingRate: 0.1525 })!;
    expect(amounts).toMatchObject({ cost: 589_971, payable: 500_000 });
    expect(applicationCheck([amounts.cost], 589_970).matches).toBe(true);
  });
});

describe("a charge without backing takes the document's", () => {
  it("is read as the total of a factura and the líquido of a boleta: what it pays stays", () => {
    expect(conversionEntryMode("factura")).toBe("total");
    expect(conversionEntryMode("boleta")).toBe("liquid");
    expect(fromTotal(210_000)).toMatchObject({ payable: 210_000, cost: 176_471 });
  });
});

describe("parseApplied", () => {
  it("takes up to what is pending", () => {
    expect(parseApplied("1680672", 1_680_672)).toEqual({ value: 1_680_672, error: null });
    expect(parseApplied("1000000", 1_680_672)).toEqual({ value: 1_000_000, error: null });
  });

  it("refuses more than is pending, zero, decimals and empty", () => {
    expect(parseApplied("1680673", 1_680_672).error).toMatch(/1\.680\.672/);
    expect(parseApplied("0", 100).error).not.toBeNull();
    expect(parseApplied("10.5", 100).error).not.toBeNull();
    expect(parseApplied("", 100).error).not.toBeNull();
  });
});

describe("payableOfApplied", () => {
  it("is what the charge pays when fully applied, and its part when not", () => {
    expect(payableOfApplied({ cost: 1_680_672, payable: 2_000_000 }, 1_680_672)).toBe(2_000_000);
    expect(payableOfApplied({ cost: 100_000, payable: 119_000 }, 50_000)).toBe(59_500);
  });
});
