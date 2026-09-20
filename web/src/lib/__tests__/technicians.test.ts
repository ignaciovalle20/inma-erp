/**
 * F1 (docs/plan-sistema-v3.md), external technicians: the pure rules behind
 * the screens. The acceptance case of the plan is here as a test: two jobs, a
 * technician paid one payment that covers both, and the saldo and the cost of
 * each job coming out right. All names and amounts invented.
 */
import { describe, it, expect } from "vitest";
import {
  chargeCost,
  defaultVatRate,
  describeTechnicianError,
  distributeOldestFirst,
  outstanding,
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
  it("is 22% for Uruguay (UYU) and 19% for Chile", () => {
    expect(defaultVatRate("UYU")).toBe(0.22);
    expect(defaultVatRate("CLP")).toBe(0.19);
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
      error: "La tarifa de hora debe ser un número mayor a cero.",
    });
    expect(parseTechnicianProfile(form({ rate_visit: "-5" })).ok).toBe(false);
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

  it("shows unknown messages as they are", () => {
    expect(describeTechnicianError("something else")).toBe("something else");
  });
});
