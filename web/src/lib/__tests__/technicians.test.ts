/**
 * F1 (docs/plan-sistema-v3.md), external technicians: the pure rules behind
 * the screens. The acceptance case of the plan is here as a test: two jobs, a
 * technician paid one payment that covers both, and the saldo and the cost of
 * each job coming out right. All names and amounts invented.
 */
import { describe, it, expect } from "vitest";
import {
  backedChargeAmounts,
  backingOfSourceType,
  enteredValueOf,
  boletaLinkCheck,
  linkAmountCheck,
  parseWholePesos,
  percentLabel,
  proposeTechnicianSuggestions,
  uniqueChargeCombination,
  withholdingRateFor,
  chargeCost,
  defaultVatRate,
  describeTechnicianError,
  distributeOldestFirst,
  outstanding,
  parsePositiveAmount,
  parseTechnicianProfile,
  paymentStatus,
  readDefaultRates,
  summarizeByProject,
  summarizeByTechnician,
  validatePayment,
  vatRateLabel,
  type ChargeSummaryInput,
} from "@/lib/technicians";

describe("defaultVatRate", () => {
  it("is 22% for Uruguay and 19% for Chile, by the company's country", () => {
    expect(defaultVatRate({ country: "UY", currency: "UYU" })).toBe(0.22);
    expect(defaultVatRate({ country: "Uruguay", currency: "UYU" })).toBe(0.22);
    expect(defaultVatRate({ country: "CL", currency: "CLP" })).toBe(0.19);
    expect(defaultVatRate({ country: null, currency: "UYU" })).toBe(0.22);
    expect(vatRateLabel(0.22)).toBe("22%");
    expect(vatRateLabel(0.19)).toBe("19%");
  });
});

describe("chargeCost", () => {
  it("takes the IVA out of an amount that includes it (Chile, 19%)", () => {
    expect(chargeCost({ amount: 119000, vatIncluded: true, vatRate: 0.19, currency: "CLP" })).toEqual({
      net: 100000,
      tax: 19000,
      total: 119000,
    });
  });

  it("uses 22% in Uruguay and keeps cents", () => {
    expect(chargeCost({ amount: 12200, vatIncluded: true, vatRate: 0.22, currency: "UYU" })).toEqual({
      net: 10000,
      tax: 2200,
      total: 12200,
    });
    expect(chargeCost({ amount: 1000, vatIncluded: true, vatRate: 0.22, currency: "UYU" })).toEqual({
      net: 819.67,
      tax: 180.33,
      total: 1000,
    });
  });

  it("rounds to whole pesos in CLP, and net + IVA always add back to the amount", () => {
    const cost = chargeCost({ amount: 50000, vatIncluded: true, vatRate: 0.19, currency: "CLP" });
    expect(cost.net).toBe(42017);
    expect(cost.tax).toBe(7983);
    expect(cost.net + cost.tax).toBe(cost.total);
  });

  it("counts the whole amount as cost when it does not include IVA", () => {
    expect(chargeCost({ amount: 80000, vatIncluded: false, vatRate: 0.19, currency: "CLP" })).toEqual({
      net: 80000,
      tax: 0,
      total: 80000,
    });
  });
});

describe("distributeOldestFirst", () => {
  const charges = [
    { id: "c-new", charge_date: "2026-09-10", outstanding: 60000 },
    { id: "c-old", charge_date: "2026-09-01", outstanding: 50000 },
    { id: "c-paid", charge_date: "2026-08-20", outstanding: 0 },
  ];

  it("pays the oldest charge first and spills into the next one", () => {
    expect(distributeOldestFirst(charges, 70000)).toEqual({
      applications: [
        { chargeId: "c-old", amount: 50000 },
        { chargeId: "c-new", amount: 20000 },
      ],
      unapplied: 0,
    });
  });

  it("leaves a partial payment on the oldest charge", () => {
    expect(distributeOldestFirst(charges, 30000).applications).toEqual([{ chargeId: "c-old", amount: 30000 }]);
  });

  it("reports what does not fit instead of inventing a charge", () => {
    const result = distributeOldestFirst(charges, 150000);
    expect(result.applications.map((a) => a.amount)).toEqual([50000, 60000]);
    expect(result.unapplied).toBe(40000);
  });

  it("does not drift with cents", () => {
    const cents = [
      { id: "a", charge_date: "2026-09-01", outstanding: 0.1 },
      { id: "b", charge_date: "2026-09-02", outstanding: 0.2 },
    ];
    expect(distributeOldestFirst(cents, 0.3)).toEqual({
      applications: [
        { chargeId: "a", amount: 0.1 },
        { chargeId: "b", amount: 0.2 },
      ],
      unapplied: 0,
    });
  });
});

describe("validatePayment", () => {
  const owed = new Map([
    ["c1", 50000],
    ["c2", 60000],
  ]);

  it("accepts a payment that covers two charges exactly", () => {
    expect(
      validatePayment({
        amount: 80000,
        applications: [
          { chargeId: "c1", amount: 50000 },
          { chargeId: "c2", amount: 30000 },
        ],
        outstandingByCharge: owed,
      }),
    ).toBeNull();
  });

  it("rejects paying a charge more than it is owed", () => {
    expect(
      validatePayment({
        amount: 55000,
        applications: [{ chargeId: "c1", amount: 55000 }],
        outstandingByCharge: owed,
      }),
    ).toMatch(/más de lo que falta/);
  });

  it("rejects a charge that is not the technician's (it is not in the owed list)", () => {
    expect(
      validatePayment({
        amount: 1000,
        applications: [{ chargeId: "somebody-else", amount: 1000 }],
        outstandingByCharge: owed,
      }),
    ).toMatch(/no es de este técnico/);
  });

  it("rejects applications that do not add up to the payment", () => {
    expect(
      validatePayment({
        amount: 80000,
        applications: [{ chargeId: "c1", amount: 50000 }],
        outstandingByCharge: owed,
      }),
    ).toMatch(/sumar exactamente/);
  });

  it("rejects an empty payment, a zero application and a repeated charge", () => {
    expect(validatePayment({ amount: 0, applications: [], outstandingByCharge: owed })).toMatch(/mayor a cero/);
    expect(validatePayment({ amount: 10, applications: [], outstandingByCharge: owed })).toMatch(/al menos un cargo/);
    expect(
      validatePayment({ amount: 10, applications: [{ chargeId: "c1", amount: 0 }], outstandingByCharge: owed }),
    ).toMatch(/mayor a cero/);
    expect(
      validatePayment({
        amount: 20,
        applications: [
          { chargeId: "c1", amount: 10 },
          { chargeId: "c1", amount: 10 },
        ],
        outstandingByCharge: owed,
      }),
    ).toMatch(/dos veces/);
  });
});

describe("saldo and job indicators (the F1 acceptance case)", () => {
  // Technician "Técnico Prueba" did two jobs; one payment of 130.000 covers both:
  // 100.000 of job A (paid in full) and 30.000 of job B (paid in part).
  const charges: ChargeSummaryInput[] = [
    { id: "ch-a", project_id: "job-a", personnel_id: "tech-1", amount: 100000, paid: 100000, document_status: "recibida" },
    { id: "ch-b", project_id: "job-b", personnel_id: "tech-1", amount: 80000, paid: 30000, document_status: "pendiente" },
    { id: "ch-c", project_id: "job-b", personnel_id: "tech-2", amount: 40000, paid: 0, document_status: "recibida" },
  ];

  it("gives each technician their own saldo and pending documents", () => {
    const summary = summarizeByTechnician(charges);

    expect(summary.get("tech-1")).toEqual({
      chargeCount: 2,
      charged: 180000,
      paid: 130000,
      balance: 50000,
      pendingDocuments: 1,
    });
    expect(summary.get("tech-2")).toEqual({
      chargeCount: 1,
      charged: 40000,
      paid: 0,
      balance: 40000,
      pendingDocuments: 0,
    });
  });

  it("says how each job stands with its technicians", () => {
    const summary = summarizeByProject(charges);

    expect(summary.get("job-a")).toMatchObject({ payment: "pagado", document: "recibida", charged: 100000 });
    // Job B has two technicians: 120.000 charged, 30.000 paid, one boleta missing.
    expect(summary.get("job-b")).toMatchObject({
      chargeCount: 2,
      charged: 120000,
      paid: 30000,
      payment: "parcial",
      document: "pendiente",
    });
    expect(summary.get("job-without-technicians")).toBeUndefined();
  });

  it("classifies the payment status", () => {
    expect(paymentStatus(100, 0)).toBe("sin_pagar");
    expect(paymentStatus(100, 40)).toBe("parcial");
    expect(paymentStatus(100, 100)).toBe("pagado");
  });

  it("never reports a negative amount owed on a charge", () => {
    expect(outstanding({ amount: 100, paid: 30 })).toBe(70);
    expect(outstanding({ amount: 100, paid: 130 })).toBe(0);
  });
});

describe("parseTechnicianProfile", () => {
  const form = (fields: Record<string, string>) => (name: string) => fields[name] ?? "";

  it("keeps only what was filled in", () => {
    const parsed = parseTechnicianProfile(
      form({
        tax_id: " 12.345.678-5 ",
        payment_document: "boleta_honorarios",
        rate_visit: "15000",
        rate_network_point: "9500.5",
        payment_details: "Banco Prueba, cuenta 000",
      }),
    );

    expect(parsed).toEqual({
      ok: true,
      value: {
        tax_id: "12.345.678-5",
        payment_document: "boleta_honorarios",
        default_rates: { visit: 15000, network_point: 9500.5 },
        payment_details: "Banco Prueba, cuenta 000",
      },
    });
  });

  it("accepts an empty ficha", () => {
    expect(parseTechnicianProfile(form({}))).toEqual({
      ok: true,
      value: { tax_id: null, payment_document: null, default_rates: {}, payment_details: null },
    });
  });

  it("rejects a rate that is not a positive number instead of storing 0", () => {
    expect(parseTechnicianProfile(form({ rate_hour: "abc" }))).toEqual({
      ok: false,
      error: 'Tarifa de hora inválida "abc": no es un importe (solo dígitos, puntos y comas)',
    });
    expect(parseTechnicianProfile(form({ rate_visit: "-5" })).ok).toBe(false);
    expect(parseTechnicianProfile(form({ rate_visit: "0" })).ok).toBe(false);
  });

  it("reads the local convention: 25.000 is twenty-five thousand, not twenty-five", () => {
    const parsed = parseTechnicianProfile(
      form({ rate_visit: "25.000", rate_hour: "12.500,50", rate_network_point: "9500,5" }),
    );

    expect(parsed).toMatchObject({
      ok: true,
      value: { default_rates: { visit: 25000, hour: 12500.5, network_point: 9500.5 } },
    });
  });

  it("rejects a rate it cannot tell apart instead of guessing", () => {
    const parsed = parseTechnicianProfile(form({ rate_visit: "25,000" }));

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(/^Tarifa de visita inválida "25,000": es ambiguo/);
  });

  it("rejects an unknown document", () => {
    expect(parseTechnicianProfile(form({ payment_document: "recibo" })).ok).toBe(false);
  });

  it("reads stored rates defensively", () => {
    expect(readDefaultRates({ visit: 100, hour: "x", other: 5, network_point: 0 })).toEqual({ visit: 100 });
    expect(readDefaultRates(null)).toEqual({});
    expect(readDefaultRates("nope")).toEqual({});
  });
});

describe("describeTechnicianError", () => {
  it("explains the rules the database enforces", () => {
    expect(
      describeTechnicianError("This charge already has payments applied: delete those payments first"),
    ).toMatch(/ya tiene pagos aplicados/);
    expect(
      describeTechnicianError("The payment applied to a charge (120) cannot exceed its amount (100)"),
    ).toMatch(/no puede aplicarse/);
    expect(describeTechnicianError("The applications (1) must add up to the payment amount (2)")).toMatch(
      /sumar exactamente/,
    );
  });

  it("says the migration is missing instead of a raw schema error", () => {
    expect(
      describeTechnicianError('relation "public.technician_charges" does not exist'),
    ).toMatch(/Falta aplicar la migración/);
    expect(
      describeTechnicianError("Could not find the function public.create_technician_charge(p_amount) in the schema cache"),
    ).toMatch(/Falta aplicar la migración/);
  });

  // What a person meets first when the migration is not applied: creating or
  // listing a technician fails on `personnel`, not on a technician_* object.
  it("says the migration is missing when the personnel columns or the type check are missing", () => {
    const missing = /Falta aplicar la migración/;

    expect(describeTechnicianError("Could not find the 'tax_id' column of 'personnel' in the schema cache")).toMatch(
      missing,
    );
    expect(describeTechnicianError("Could not find the 'default_rates' column of 'personnel' in the schema cache")).toMatch(
      missing,
    );
    expect(describeTechnicianError("column personnel.tax_id does not exist")).toMatch(missing);
    expect(
      describeTechnicianError('new row for relation "personnel" violates check constraint "personnel_type_check"'),
    ).toMatch(missing);
  });

  it("does not blame the migration for an unrelated missing column", () => {
    expect(describeTechnicianError("column clients.zzz does not exist")).toBe("column clients.zzz does not exist");
  });

  it("shows unknown messages as they are", () => {
    expect(describeTechnicianError("something else")).toBe("something else");
  });
});

// ---------------------------------------------------------------------
// Chile: backing of a charge, documents and suggestions (20261026010000)
// ---------------------------------------------------------------------

const RATES = [
  { year: 2025, rate: 0.145 },
  { year: 2026, rate: 0.1525 },
  { year: 2027, rate: 0.16 },
  { year: 2028, rate: 0.17 },
];

describe("withholdingRateFor", () => {
  it("takes the rate of the charge's year, and the latest one from 2028 on", () => {
    expect(withholdingRateFor(RATES, "2025-03-01")).toBe(0.145);
    expect(withholdingRateFor(RATES, "2026-10-26")).toBe(0.1525);
    expect(withholdingRateFor(RATES, "2027-01-01")).toBe(0.16);
    expect(withholdingRateFor(RATES, "2028-06-30")).toBe(0.17);
    expect(withholdingRateFor(RATES, "2031-12-31")).toBe(0.17);
  });

  it("has no rate before the first year of the table", () => {
    expect(withholdingRateFor(RATES, "2024-12-31")).toBeNull();
  });
});

describe("backedChargeAmounts", () => {
  it("boleta from the líquido: 375.000 in 2026 -> bruto 442.478, retención 67.478", () => {
    const amounts = backedChargeAmounts({ backing: "boleta", enteredAs: "liquid", value: 375000, withholdingRate: 0.1525 });
    expect(amounts).toEqual({ payable: 375000, cost: 442478, vat: 0, withholding: 67478, withholdingRate: 0.1525 });
  });

  it("boleta from the bruto gives the same: cost of the job 442.478, a pagar 375.000", () => {
    const amounts = backedChargeAmounts({ backing: "boleta", enteredAs: "gross", value: 442478, withholdingRate: 0.1525 });
    expect(amounts).toEqual({ payable: 375000, cost: 442478, vat: 0, withholding: 67478, withholdingRate: 0.1525 });
  });

  it("factura from the net: 100.000 -> total 119.000", () => {
    expect(backedChargeAmounts({ backing: "factura", enteredAs: "net", value: 100000, withholdingRate: null })).toEqual({
      payable: 119000,
      cost: 100000,
      vat: 19000,
      withholding: 0,
      withholdingRate: null,
    });
  });

  it("factura from the total: 119.000 -> net 100.000", () => {
    expect(backedChargeAmounts({ backing: "factura", enteredAs: "total", value: 119000, withholdingRate: null })).toEqual({
      payable: 119000,
      cost: 100000,
      vat: 19000,
      withholding: 0,
      withholdingRate: null,
    });
  });

  it("sin respaldo: the cost is what is paid", () => {
    expect(backedChargeAmounts({ backing: "none", enteredAs: "amount", value: 85000, withholdingRate: null })).toEqual({
      payable: 85000,
      cost: 85000,
      vat: 0,
      withholding: 0,
      withholdingRate: null,
    });
  });

  it("refuses what it cannot compute: decimals, zero, a boleta without a rate", () => {
    expect(backedChargeAmounts({ backing: "none", enteredAs: "amount", value: 100.5, withholdingRate: null })).toBeNull();
    expect(backedChargeAmounts({ backing: "factura", enteredAs: "net", value: 0, withholdingRate: null })).toBeNull();
    expect(backedChargeAmounts({ backing: "boleta", enteredAs: "liquid", value: 1000, withholdingRate: null })).toBeNull();
  });
});

describe("QA 2026-10-27: amounts that force rounding", () => {
  // round(num / den), halves up, in exact integers: what numeric does in the database.
  const big = (value: number) => BigInt(value);
  const exact = (num: bigint, den: bigint) => Number((big(2) * num + den) / (big(2) * den));

  it("boleta, every year, from the líquido and from the bruto: bruto − retención = líquido, always", () => {
    for (const { year, rate } of RATES) {
      for (const value of [1, 999, 375000, 1000001]) {
        const fromLiquid = backedChargeAmounts({ backing: "boleta", enteredAs: "liquid", value, withholdingRate: rate })!;
        expect(fromLiquid.payable, `${year} líquido ${value}`).toBe(value);
        expect(fromLiquid.cost - fromLiquid.withholding).toBe(fromLiquid.payable);
        const fromGross = backedChargeAmounts({ backing: "boleta", enteredAs: "gross", value, withholdingRate: rate })!;
        expect(fromGross.cost, `${year} bruto ${value}`).toBe(value);
        expect(fromGross.cost - fromGross.withholding).toBe(fromGross.payable);
      }
    }
  });

  it("matches exact rounding for every amount up to 200.000 (the float version missed by a peso: bruto 100 in 2025)", () => {
    expect(backedChargeAmounts({ backing: "boleta", enteredAs: "gross", value: 100, withholdingRate: 0.145 })?.withholding).toBe(15);
    for (const { rate } of RATES) {
      const points = BigInt(Math.round(rate * 10000));
      for (let value = 1; value <= 200000; value++) {
        const v = BigInt(value);
        const fromLiquid = backedChargeAmounts({ backing: "boleta", enteredAs: "liquid", value, withholdingRate: rate })!;
        const fromGross = backedChargeAmounts({ backing: "boleta", enteredAs: "gross", value, withholdingRate: rate })!;
        if (fromLiquid.cost !== exact(v * big(10000), big(10000) - points)) throw new Error(`líquido ${value} at ${rate}`);
        if (fromGross.withholding !== exact(v * points, big(10000))) throw new Error(`bruto ${value} at ${rate}`);
      }
    }
    for (let value = 1; value <= 200000; value++) {
      const v = BigInt(value);
      const fromNet = backedChargeAmounts({ backing: "factura", enteredAs: "net", value, withholdingRate: null })!;
      const fromTotal = backedChargeAmounts({ backing: "factura", enteredAs: "total", value, withholdingRate: null })!;
      if (fromNet.vat !== exact(v * big(19), big(100))) throw new Error(`neto ${value}`);
      if (fromTotal.cost !== exact(v * big(100), big(119))) throw new Error(`total ${value}`);
    }
  });

  it("factura: net + IVA = total exactly, from the net and from a total that rounds", () => {
    const fromTotal = backedChargeAmounts({ backing: "factura", enteredAs: "total", value: 100000, withholdingRate: null })!;
    expect(fromTotal).toMatchObject({ cost: 84034, vat: 15966, payable: 100000 });
    for (const value of [1, 7, 999, 100000, 1000001]) {
      for (const enteredAs of ["net", "total"] as const) {
        const amounts = backedChargeAmounts({ backing: "factura", enteredAs, value, withholdingRate: null })!;
        expect(amounts.cost + amounts.vat, `${enteredAs} ${value}`).toBe(amounts.payable);
      }
    }
  });

  it("the amount field takes 375000, 375.000 and a pasted amount with spaces; refuses negatives, zero and text", () => {
    for (const raw of ["375000", "375.000", " 375.000 ", "375 000", "\t375.000\n"]) {
      expect(parseWholePesos(raw), JSON.stringify(raw)).toEqual({ kind: "ok", value: 375000 });
    }
    for (const raw of ["-375000", "0", "abc", "375,5", "1.2.3,4,5"]) {
      expect(parseWholePesos(raw).kind, raw).toBe("invalid");
    }
    expect(parseWholePesos("").kind).toBe("empty");
  });
});

describe("parseWholePesos", () => {
  it("takes the amount with or without thousands dots", () => {
    expect(parseWholePesos("375.000")).toEqual({ kind: "ok", value: 375000 });
    expect(parseWholePesos("375000")).toEqual({ kind: "ok", value: 375000 });
  });

  it("refuses cents", () => {
    expect(parseWholePesos("375000,5").kind).toBe("invalid");
  });
});

describe("enteredValueOf", () => {
  it("starts the correction from the value as it was typed", () => {
    expect(enteredValueOf({ backing: "boleta", entered_as: "liquid", amount: 375000, net_amount: 442478 })).toEqual({
      enteredAs: "liquid",
      value: 375000,
    });
    expect(enteredValueOf({ backing: "factura", entered_as: "net", amount: 119000, net_amount: 100000 })).toEqual({
      enteredAs: "net",
      value: 100000,
    });
    // A migrated charge (no entry mode): the first mode of its backing.
    expect(enteredValueOf({ backing: "factura", entered_as: null, amount: 119000, net_amount: 100000 })).toEqual({
      enteredAs: "net",
      value: 100000,
    });
  });
});

describe("backingOfSourceType", () => {
  it("tells a factura from a boleta by the Nubox type code", () => {
    expect(backingOfSourceType("FAC-EL")).toBe("factura");
    expect(backingOfSourceType("FAC-EE")).toBe("factura");
    expect(backingOfSourceType("BOL-HE")).toBe("boleta");
    expect(backingOfSourceType("BOL-TE")).toBe("boleta");
    expect(backingOfSourceType("N/C-EL")).toBeNull();
    expect(backingOfSourceType(null)).toBeNull();
  });
});

describe("boletaLinkCheck", () => {
  const charge = { cost: 589970, payable: 500000 };

  it("cuadra bruto con bruto y líquido con líquido", () => {
    expect(boletaLinkCheck([charge], { gross: 589970, liquid: 500000 })).toMatchObject({
      gross: { matches: true, difference: 0 },
      liquid: { matches: true, difference: 0 },
      looksCrossed: false,
    });
  });

  it("says the amounts look crossed when the boleta's bruto is what the charge pays (BOL-HE 156)", () => {
    expect(boletaLinkCheck([charge], { gross: 500000, liquid: 423750 })).toMatchObject({
      gross: { matches: false, difference: -89970 },
      looksCrossed: true,
    });
  });

  it("flags a líquido that differs while the bruto matches, without calling it crossed", () => {
    expect(boletaLinkCheck([charge], { gross: 589970, liquid: 589970 })).toMatchObject({
      gross: { matches: true },
      liquid: { matches: false },
      looksCrossed: false,
    });
  });

  it("allows a peso of rounding per charge on both sides", () => {
    const check = boletaLinkCheck([{ cost: 589971, payable: 500000 }], { gross: 589970, liquid: 500000 });
    expect(check.gross.matches).toBe(true);
  });
});

describe("linkAmountCheck", () => {
  it("allows 1 peso of rounding per charge and says the difference", () => {
    expect(linkAmountCheck([100000, 100000, 100000], 300000)).toEqual({ sum: 300000, difference: 0, matches: true });
    expect(linkAmountCheck([100001, 100001, 100001], 300000)).toMatchObject({ matches: true, difference: -3 });
    expect(linkAmountCheck([100000, 90000], 200000)).toEqual({ sum: 190000, difference: 10000, matches: false });
    expect(linkAmountCheck([], 0).matches).toBe(false);
  });
});

describe("uniqueChargeCombination / proposeTechnicianSuggestions", () => {
  const charge = (id: string, cost: number, overrides: Partial<{ chargeDate: string; backing: "factura" | "boleta" }> = {}) => ({
    id,
    personnelId: "tech-1",
    backing: overrides.backing ?? ("boleta" as const),
    chargeDate: overrides.chargeDate ?? "2026-10-01",
    cost,
  });
  const document = (net: number, overrides: Partial<{ id: string; documentDate: string; backing: "factura" | "boleta" }> = {}) => ({
    id: overrides.id ?? "doc-1",
    personnelId: "tech-1",
    backing: overrides.backing ?? ("boleta" as const),
    documentDate: overrides.documentDate ?? "2026-10-20",
    net,
  });

  it("suggests the two charges whose gross adds up to the boleta", () => {
    const charges = [charge("a", 442478), charge("b", 57522), charge("c", 100000)];
    expect(proposeTechnicianSuggestions([document(500000)], charges)).toEqual([
      { documentId: "doc-1", personnelId: "tech-1", chargeIds: ["a", "b"] },
    ]);
  });

  it("suggests nothing when two combinations fit", () => {
    const charges = [charge("a", 100000), charge("b", 100000), charge("c", 50000)];
    expect(proposeTechnicianSuggestions([document(150000)], charges)).toEqual([]);
  });

  it("only looks at charges of the same backing, dated on or before the document", () => {
    const charges = [
      charge("later", 100000, { chargeDate: "2026-11-01" }),
      charge("factura", 100000, { backing: "factura" }),
      charge("ok", 100000),
    ];
    expect(proposeTechnicianSuggestions([document(100000)], charges)).toEqual([
      { documentId: "doc-1", personnelId: "tech-1", chargeIds: ["ok"] },
    ]);
  });

  it("does not offer a charge to two documents, nor one already in a pending suggestion", () => {
    const charges = [charge("a", 100000)];
    expect(
      proposeTechnicianSuggestions(
        [document(100000, { id: "doc-1" }), document(100000, { id: "doc-2", documentDate: "2026-10-25" })],
        charges,
      ),
    ).toEqual([{ documentId: "doc-1", personnelId: "tech-1", chargeIds: ["a"] }]);
    expect(proposeTechnicianSuggestions([document(100000)], charges, ["a"])).toEqual([]);
  });

  it("gives up beyond 15 candidates instead of guessing", () => {
    // One charge of 1.000 and small ones that never add up to it: one answer, if all are searched.
    const many = Array.from({ length: 16 }, (_, index) => ({ id: `c${index}`, cost: index === 0 ? 1000 : 3 }));
    expect(uniqueChargeCombination(many, 1000)).toBeNull();
    expect(uniqueChargeCombination(many.slice(0, 15), 1000)).toEqual(["c0"]);
  });
});

describe("summaries with charges sin respaldo", () => {
  const base = { personnel_id: "tech-1", amount: 1000, paid: 0 };
  it("a charge without backing (no aplica) never counts as a pending document", () => {
    const charges: ChargeSummaryInput[] = [
      { ...base, id: "a", project_id: "job-1", document_status: "no_aplica" },
      { ...base, id: "b", project_id: "job-2", document_status: "no_aplica" },
      { ...base, id: "c", project_id: "job-2", document_status: "recibida" },
      { ...base, id: "d", project_id: "job-3", document_status: "pendiente" },
    ];
    expect(summarizeByTechnician(charges).get("tech-1")?.pendingDocuments).toBe(1);
    const byJob = summarizeByProject(charges);
    expect(byJob.get("job-1")?.document).toBe("no_aplica");
    expect(byJob.get("job-2")?.document).toBe("recibida");
    expect(byJob.get("job-3")?.document).toBe("pendiente");
  });
});

describe("percentLabel and the Chilean ficha", () => {
  it("writes the retención with its decimals", () => {
    expect(percentLabel(0.1525)).toBe("15,25%");
    expect(percentLabel(0.19)).toBe("19%");
  });

  it("reads Respaldo habitual and keeps the document column in step", () => {
    const form = (fields: Record<string, string>) => (name: string) => fields[name] ?? "";
    expect(parseTechnicianProfile(form({ default_backing: "boleta" }))).toMatchObject({
      ok: true,
      value: { default_backing: "boleta", payment_document: "boleta_honorarios" },
    });
    expect(parseTechnicianProfile(form({ default_backing: "none" }))).toMatchObject({
      ok: true,
      value: { default_backing: "none", payment_document: null },
    });
    expect(parseTechnicianProfile(form({ default_backing: "recibo" })).ok).toBe(false);
  });
});

describe("parsePositiveAmount", () => {
  it("reads dot thousands and comma decimals", () => {
    expect(parsePositiveAmount("25.000")).toEqual({ kind: "ok", value: 25000 });
    expect(parsePositiveAmount("25000")).toEqual({ kind: "ok", value: 25000 });
    expect(parsePositiveAmount("1.234.567")).toEqual({ kind: "ok", value: 1234567 });
    expect(parsePositiveAmount("9500,5")).toEqual({ kind: "ok", value: 9500.5 });
    expect(parsePositiveAmount(" 9500.5 ")).toEqual({ kind: "ok", value: 9500.5 });
  });

  it("tells an empty field from an invalid one", () => {
    expect(parsePositiveAmount("")).toEqual({ kind: "empty" });
    expect(parsePositiveAmount("   ")).toEqual({ kind: "empty" });
    expect(parsePositiveAmount("abc").kind).toBe("invalid");
  });

  it("rejects zero and negatives: an amount here is always something owed", () => {
    expect(parsePositiveAmount("0")).toEqual({ kind: "invalid", reason: '"0": tiene que ser mayor a cero' });
    expect(parsePositiveAmount("-5").kind).toBe("invalid");
  });

  it("rejects an ambiguous amount instead of guessing", () => {
    expect(parsePositiveAmount("25,000").kind).toBe("invalid");
  });
});
