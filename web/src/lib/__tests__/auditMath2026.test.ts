/**
 * Audit 2026-11 (audit/INFORME_MATEMATICA_2026-11.md): the formulas with their
 * edge cases (rounding, credit notes, totals with IVA, zero, large amounts),
 * property tests where the rule is an identity (a split adds up to its total,
 * net + IVA = total, a round trip returns the start) and one golden case per
 * bug found (M-xx). Property tests use a seeded generator: a failure always
 * reproduces with the same inputs.
 */
import { describe, expect, it } from "vitest";
import { marginPercent, percentOfSales } from "@/lib/margins";
import { proposeCostAllocations, splitByLargestRemainder } from "@/lib/costAllocationSuggestions";
import { attributeSale } from "@/lib/salesAttribution";
import { backedChargeAmounts, chargeCost, withholdingRateFor } from "@/lib/technicians";
import { buildRateTable, combineSummaries, convertOn, summarizeMoney } from "@/lib/multiCurrency";
import { resolveSaleAmounts } from "@/lib/genericImport";
import { resolvePurchaseRow } from "@/lib/purchaseImport";
import { totalWithVat } from "@/lib/vat";
import { poolCoverageGaps } from "@/lib/msLicensePool";
import { roundToCurrency, tooManyDecimals } from "@/lib/currencies";

/** Deterministic PRNG (mulberry32). */
function rng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const int = (random: () => number, min: number, max: number) => min + Math.floor(random() * (max - min + 1));

// The Boleta rates of boleta_withholding_rates (Ley 21.133; 2026 = 15,25 %,
// checked against the SII calendar on 2026-11-08).
const RATES = [
  { year: 2024, rate: 0.1375 },
  { year: 2025, rate: 0.145 },
  { year: 2026, rate: 0.1525 },
  { year: 2027, rate: 0.16 },
  { year: 2028, rate: 0.17 },
];

describe("margin percentages (M-07)", () => {
  it("gives null over zero and over a negative base, never a flipped sign", () => {
    // Revenue -100 (credit notes over invoices), costs 50: margin -150.
    // -150 / -100 * 100 used to read "+150 %".
    expect(marginPercent(-150, -100)).toBeNull();
    expect(marginPercent(50, 0)).toBeNull();
    expect(percentOfSales(10, 0)).toBeNull();
    expect(percentOfSales(Number.NaN, 100)).toBeNull();
  });

  it("is the plain ratio over a positive base", () => {
    expect(marginPercent(25, 100)).toBe(25);
    expect(marginPercent(-50, 100)).toBe(-50);
    expect(percentOfSales(1_234_567_890, 9_876_543_210)).toBeCloseTo(12.4999, 3);
  });
});

describe("largest-remainder split (cost periods, mirror of the MS pool split)", () => {
  it("always adds up exactly to the total, with whole units and no negative part (property)", () => {
    const random = rng(20261108);
    for (let run = 0; run < 2_000; run += 1) {
      const currency = random() < 0.5 ? "CLP" : "USD";
      const total = currency === "CLP" ? int(random, 0, 50_000_000) : int(random, 0, 5_000_000) / 100;
      const weights = Array.from({ length: int(random, 1, 8) }, () => (random() < 0.15 ? 0 : int(random, 0, 1_000_000)));
      const shares = splitByLargestRemainder(total, weights, currency);
      const factor = currency === "CLP" ? 1 : 100;
      const sumUnits = shares.reduce((sum, share) => sum + Math.round(share * factor), 0);
      expect(sumUnits).toBe(Math.round(total * factor));
      for (const [index, share] of shares.entries()) {
        expect(share).toBeGreaterThanOrEqual(0);
        expect(tooManyDecimals(share, factor)).toBe(false);
        // A client sold at 0 takes nothing (unless every weight is 0).
        if (weights[index] === 0 && weights.some((weight) => weight > 0)) expect(share).toBe(0);
      }
    }
  });

  it("gives each part within one unit of its exact proportion", () => {
    const shares = splitByLargestRemainder(1_036_626, [600_000, 614_576, 102_447, 470_595], "CLP");
    // The four Chile MS services of 2026-11: the split that should have been made (M-01).
    expect(shares).toEqual([347_935, 356_388, 59_408, 272_895]);
    expect(shares.reduce((sum, share) => sum + share, 0)).toBe(1_036_626);
  });
});

describe("MS pool coverage (M-01, golden)", () => {
  it("lists the cycles created after the split and shares left on voided cycles", () => {
    const cycle = (occurrenceId: string, status: string) => ({
      occurrenceId, status, serviceName: occurrenceId, clientName: null, amount: 1,
    });
    // Prod, Chile 2026-11: split on 2026-11-04 21:08 among Razo and TREI;
    // SIMTA created 21:35 and TOTAL GP on 2026-11-08 carry nothing.
    const gaps = poolCoverageGaps(
      [cycle("Razo", "pending_invoice"), cycle("TREI", "pending_invoice"), cycle("SIMTA", "pending_invoice"), cycle("TOTAL GP", "pending_invoice"), cycle("Anulado", "void")],
      new Set(["Razo", "TREI", "Anulado"]),
    );
    expect(gaps.missing.map((c) => c.occurrenceId)).toEqual(["SIMTA", "TOTAL GP"]);
    expect(gaps.onVoid.map((c) => c.occurrenceId)).toEqual(["Anulado"]);
  });

  it("says nothing when the split covers the month", () => {
    const gaps = poolCoverageGaps(
      [{ occurrenceId: "a", status: "invoiced", serviceName: "a", clientName: null, amount: 1 }],
      new Set(["a"]),
    );
    expect(gaps).toEqual({ missing: [], onVoid: [] });
  });
});

describe("cost-period suggestions with a rounding difference (M-05, golden)", () => {
  const doc = (id: string, net: number) => ({
    id, supplierId: "starlink", currency: "CLP", netAmount: net, month: "2026-05", documentDate: `2026-05-${id.padStart(2, "0")}`,
  });
  const period = (id: string, expected: number) => ({
    id, supplierId: "starlink", currency: "CLP", month: "2026-05", expected, serviceName: id,
  });

  it("suggests (never confirms) an invoice one peso away from the expected cost", () => {
    // Prod: WIND - 2025, 2026-05, expected 39.496; Starlink invoices 2651443 and
    // 2714609 of 39.495 stayed general costs while the period counted 39.496.
    const proposals = proposeCostAllocations([doc("1", 39_495), doc("2", 39_495)], [period("WIND - 2025", 39_496)]);
    expect(proposals).toEqual([
      { documentId: "1", costPeriodId: "WIND - 2025", amount: 39_495, status: "suggested", reason: "rounding" },
    ]);
  });

  it("keeps exact matches first and confirmed", () => {
    const proposals = proposeCostAllocations([doc("1", 31_092), doc("2", 31_093)], [period("A", 31_092), period("B", 31_092)]);
    expect(proposals).toEqual([
      // Two periods of 31.092 and one invoice of that amount: a batch, confirmed.
      { documentId: "1", costPeriodId: "A", amount: 31_092, status: "confirmed", reason: "same_amount_batch" },
      { documentId: "2", costPeriodId: "B", amount: 31_093, status: "suggested", reason: "rounding" },
    ]);
  });

  it("does not pair amounts two units apart", () => {
    expect(proposeCostAllocations([doc("1", 39_494), doc("2", 1)], [period("A", 39_496)])).toEqual([]);
  });
});

describe("sales attribution: the parts always add up to the document", () => {
  it("holds for invoices split among jobs and services, and for credit notes (property)", () => {
    const random = rng(7);
    const areas = new Map<string, string | null>([["j1", "a1"], ["j2", null], ["j3", "a2"]]);
    for (let run = 0; run < 1_000; run += 1) {
      const isCreditNote = random() < 0.2;
      const net = int(random, 1, 10_000_000);
      const allocations = isCreditNote
        ? []
        : Array.from({ length: int(random, 0, 4) }, (_, i) => ({
            salesDocumentId: "s",
            amount: int(random, 0, Math.floor(net / 4)),
            projectId: i % 2 === 0 ? `j${int(random, 1, 3)}` : null,
            serviceAreaId: i % 2 === 0 ? null : random() < 0.5 ? "a3" : null,
            kind: (i % 2 === 0 ? "quote" : "period") as "quote" | "period",
          }));
      const amount = isCreditNote ? -net : net;
      const parts = attributeSale({ amount, documentType: isCreditNote ? "credit_note" : "invoice", projectId: "j1", businessAreaId: null }, allocations, areas);
      expect(parts.reduce((sum, part) => sum + part.amount, 0)).toBe(amount);
    }
  });
});

describe("technician charges", () => {
  it("factura: neto -> total -> neto returns the start, and neto + IVA = total (property)", () => {
    const random = rng(19);
    for (let run = 0; run < 5_000; run += 1) {
      const net = int(random, 1, 50_000_000);
      const fromNet = backedChargeAmounts({ backing: "factura", enteredAs: "net", value: net, withholdingRate: null })!;
      expect(fromNet.cost + fromNet.vat).toBe(fromNet.payable);
      expect(fromNet.vat).toBe(Math.round(net * 0.19));
      const back = backedChargeAmounts({ backing: "factura", enteredAs: "total", value: fromNet.payable, withholdingRate: null })!;
      expect(back.cost).toBe(net);
    }
  });

  it("boleta 2026: líquido -> bruto -> líquido returns the start, and líquido + retención = bruto (property)", () => {
    const rate = withholdingRateFor(RATES, "2026-07-22")!;
    expect(rate).toBe(0.1525);
    const random = rng(23);
    for (let run = 0; run < 5_000; run += 1) {
      const liquid = int(random, 1, 20_000_000);
      const fromLiquid = backedChargeAmounts({ backing: "boleta", enteredAs: "liquid", value: liquid, withholdingRate: rate })!;
      expect(fromLiquid.payable + fromLiquid.withholding).toBe(fromLiquid.cost);
      const back = backedChargeAmounts({ backing: "boleta", enteredAs: "gross", value: fromLiquid.cost, withholdingRate: rate })!;
      expect(back.payable).toBe(liquid);
      expect(back.withholding).toBe(Math.round(fromLiquid.cost * 0.1525));
    }
  });

  it("boleta: the SII example (bruto 100.000 -> retención 15.250, líquido 84.750) and the cost for INMA is the bruto", () => {
    expect(backedChargeAmounts({ backing: "boleta", enteredAs: "gross", value: 100_000, withholdingRate: 0.1525 })).toEqual({
      payable: 84_750, cost: 100_000, vat: 0, withholding: 15_250, withholdingRate: 0.1525,
    });
  });

  it("sin respaldo: the cost is exactly what is paid, without IVA", () => {
    expect(backedChargeAmounts({ backing: "none", enteredAs: "amount", value: 375_000, withholdingRate: null })).toEqual({
      payable: 375_000, cost: 375_000, vat: 0, withholding: 0, withholdingRate: null,
    });
    // Uruguay records no backing: the charge is entered as amount without IVA.
    expect(chargeCost({ amount: 2_990, vatIncluded: false, vatRate: 0.22, currency: "UYU" })).toEqual({ net: 2_990, tax: 0, total: 2_990 });
  });

  it("chargeCost with IVA included: net + tax = total, whole pesos in CLP, cents otherwise (property)", () => {
    const random = rng(29);
    for (let run = 0; run < 3_000; run += 1) {
      const clp = random() < 0.5;
      const amount = clp ? int(random, 1, 30_000_000) : int(random, 1, 3_000_000) / 100;
      const cost = chargeCost({ amount, vatIncluded: true, vatRate: clp ? 0.19 : 0.22, currency: clp ? "CLP" : "USD" });
      expect(Math.round((cost.net + cost.tax) * 100)).toBe(Math.round(amount * 100));
      expect(tooManyDecimals(cost.net, clp ? 1 : 100)).toBe(false);
    }
  });

  it("rejects what cannot be a charge", () => {
    expect(backedChargeAmounts({ backing: "factura", enteredAs: "net", value: 0, withholdingRate: null })).toBeNull();
    expect(backedChargeAmounts({ backing: "factura", enteredAs: "net", value: 10.5, withholdingRate: null })).toBeNull();
    expect(backedChargeAmounts({ backing: "boleta", enteredAs: "liquid", value: 1000, withholdingRate: null })).toBeNull();
  });
});

describe("exchange rates (snapshots in ARS)", () => {
  // Prod snapshots of 2026-10.
  const table = buildRateTable([
    { currency: "CLP", period: "2026-10-01", ars_per_unit: 1.55085, ars_per_usd: 1510.49 },
    { currency: "UYU", period: "2026-10-01", ars_per_unit: 37.7598, ars_per_usd: 1510.49 },
    { currency: "UYU", period: "2026-12-01", ars_per_unit: 38.2, ars_per_usd: 1540 },
  ]);

  it("converts there and back to the start (property)", () => {
    const random = rng(31);
    const pairs: [string, string][] = [["USD", "UYU"], ["UYU", "USD"], ["CLP", "USD"], ["CLP", "UYU"]];
    for (let run = 0; run < 2_000; run += 1) {
      const [from, to] = pairs[int(random, 0, pairs.length - 1)];
      const amount = int(random, 1, 1_000_000_000) / 100;
      const there = convertOn(table, amount, from, to, "2026-10-15")!;
      const back = convertOn(table, there, to, from, "2026-10-15")!;
      expect(Math.abs(back - amount)).toBeLessThan(1e-6 * Math.max(1, amount));
    }
  });

  it("uses the month's snapshot, else the nearest earlier one, and never a guessed 1:1", () => {
    // November has no UYU snapshot: October's. December has its own.
    expect(convertOn(table, 100, "USD", "UYU", "2026-11-20")).toBeCloseTo(100 * 1510.49 / 37.7598, 6);
    expect(convertOn(table, 100, "USD", "UYU", "2026-12-02")).toBeCloseTo(100 * 1540 / 38.2, 6);
    // Before the first snapshot: no rate.
    expect(convertOn(table, 100, "USD", "UYU", "2026-09-30")).toBeNull();
    expect(convertOn(table, 100, "CLP", "CLP", "1990-01-01")).toBe(100);
  });

  it("adds a credit note with its sign, per currency and in local + USD, and the margin is the same subtraction", () => {
    const sales = summarizeMoney(
      [
        { amount: 1_000, currency: "USD", date: "2026-10-05", rateToLocal: 40 },
        { amount: -200, currency: "USD", date: "2026-10-06", rateToLocal: 40 },
        { amount: 10_000, currency: "UYU", date: "2026-10-07" },
      ],
      "UYU",
      table,
    );
    expect(sales.byCurrency).toEqual([
      { currency: "USD", amount: 800, count: 2 },
      { currency: "UYU", amount: 10_000, count: 1 },
    ]);
    expect(sales.local).toBe(42_000);
    const costs = summarizeMoney([{ amount: 2_000, currency: "UYU", date: "2026-10-07" }], "UYU", table);
    const margin = combineSummaries("UYU", [{ summary: sales }, { summary: costs, sign: -1 }]);
    expect(margin.local).toBe(40_000);
    expect(margin.usd).toBeCloseTo(sales.usd - costs.usd, 9);
  });

  it("flags a total as incomplete instead of adding 0 when a month has no rate", () => {
    const summary = summarizeMoney([{ amount: 1_000, currency: "CLP", date: "2025-12-15" }], "CLP", table);
    expect(summary.local).toBe(1_000);
    expect(summary.usdComplete).toBe(false);
    expect(summary.usd).toBe(0);
  });
});

describe("net / IVA / total in the importers", () => {
  it("total with IVA included: net + IVA is exactly the total, rounded to the currency (property)", () => {
    const random = rng(37);
    for (let run = 0; run < 3_000; run += 1) {
      const clp = random() < 0.5;
      const total = clp ? int(random, 1, 90_000_000) : int(random, 1, 9_000_000) / 100;
      const text = clp ? String(total) : total.toFixed(2).replace(".", ",");
      const result = resolveSaleAmounts({
        basis: "total_with_tax", amountCell: text, taxCell: null, vatRate: clp ? 0.19 : 0.22, currency: clp ? "CLP" : "UYU",
      });
      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") continue;
      const factor = clp ? 1 : 100;
      expect(Math.round(result.value.net * factor) + Math.round(result.value.tax * factor)).toBe(Math.round(total * factor));
      expect(tooManyDecimals(result.value.net, factor)).toBe(false);
      expect(tooManyDecimals(result.value.tax, factor)).toBe(false);
    }
  });

  it("CLP takes whole pesos only (M-09, golden)", () => {
    const result = resolveSaleAmounts({ basis: "net", amountCell: "1234,5", taxCell: null, vatRate: 0.19, currency: "CLP" });
    expect(result).toEqual({ kind: "invalid", reason: "el importe 1234.5 tiene decimales: en CLP los montos van en pesos enteros" });
    expect(resolveSaleAmounts({ basis: "net", amountCell: "10,125", taxCell: null, vatRate: 0.22, currency: "USD" }).kind).toBe("invalid");
    expect(resolveSaleAmounts({ basis: "net", amountCell: "1.234.567", taxCell: "234.568", vatRate: 0.19, currency: "CLP" })).toEqual({
      kind: "ok", value: { net: 1_234_567, tax: 234_568, total: 1_469_135, taxComputed: false },
    });
  });

  const cells = (values: Record<string, string>) => ({
    net: values.net !== undefined ? { header: "Neto", value: values.net } : null,
    exempt: values.exempt !== undefined ? { header: "Exento", value: values.exempt } : null,
    tax: values.tax !== undefined ? { header: "IVA", value: values.tax } : null,
    otherTaxes: null,
    total: values.total !== undefined ? { header: "Total", value: values.total } : null,
    documentType: values.type !== undefined ? { header: "Tipo", value: values.type } : null,
    documentNumber: null,
    status: null,
  });

  it("purchases: neto + exento is rounded to the currency, never a float like 0.30000000000000004 (M-09, golden)", () => {
    const result = resolvePurchaseRow(cells({ net: "0,1", exempt: "0,2", tax: "0" }), { currency: "USD" });
    expect(result.error).toBeNull();
    expect(result.amounts?.netAmount).toBe(0.3);
    expect(result.amounts?.totalAmount).toBe(0.3);
  });

  it("purchases: a CLP amount with decimals is refused with its column (M-09)", () => {
    const result = resolvePurchaseRow(cells({ net: "1000,5", tax: "190" }), { currency: "CLP" });
    expect(result.error).toContain("Neto");
    expect(result.error).toContain("pesos enteros");
  });

  it("purchases: a credit note written negative is the same note, stored with its sign by the database", () => {
    const result = resolvePurchaseRow(cells({ net: "-31.092", tax: "-5.907", total: "-36.999", type: "N/C-EL" }), { currency: "CLP" });
    expect(result.error).toBeNull();
    expect(result.amounts).toMatchObject({ documentType: "credit_note", netAmount: 31_092, taxAmount: 5_907, totalAmount: 36_999 });
  });

  it("IVA reference total: net + IVA, rounded per currency; nothing for a 0 or negative net", () => {
    expect(totalWithVat(1_036_626, "CL", 0)).toEqual({ rate: 0.19, vat: 196_959, total: 1_233_585 });
    expect(totalWithVat(279.1, "UY", 2)).toEqual({ rate: 0.22, vat: 61.4, total: 340.5 });
    expect(totalWithVat(0, "CL", 0)).toBeNull();
    expect(totalWithVat(100, "AR", 2)).toBeNull();
  });

  it("roundToCurrency: whole pesos for CLP, cents for USD/UYU, also for huge amounts", () => {
    expect(roundToCurrency(1_469_134.5, "CLP")).toBe(1_469_135);
    expect(roundToCurrency(0.1 + 0.2, "USD")).toBe(0.3);
    expect(roundToCurrency(999_999_999_999.994, "UYU")).toBe(999_999_999_999.99);
  });
});
