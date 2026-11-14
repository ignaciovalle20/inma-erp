import { describe, expect, it } from "vitest";
import {
  computeProjectSummary,
  costAllocationShare,
  projectSummaryFromRows,
  quotedTotal,
  totalProjectSummaries,
  type ProjectSummary,
  type ProjectSummaryInput,
  type ProjectSummaryRows,
} from "@/lib/projectSummary";

describe("quotedTotal (list column = detail card)", () => {
  it("adds the quotes that have an amount (numeric strings too)", () => {
    expect(quotedTotal([{ quoted_amount: 100 }, { quoted_amount: null }, { quoted_amount: "50.5" }], 999)).toBe(150.5);
  });
  it("falls back to the job's quoted amount when no quote has one, or there are no quotes", () => {
    expect(quotedTotal([{ quoted_amount: null }], 700)).toBe(700);
    expect(quotedTotal([], 700)).toBe(700);
    expect(quotedTotal([], null)).toBeNull();
  });
});

function input(overrides: Partial<ProjectSummaryInput> = {}): ProjectSummaryInput {
  return {
    currency: "CLP",
    quoted: 1_000_000,
    billed: 800_000,
    costs: [],
    technicianCharges: [],
    technicianDocumentIds: new Set(),
    ...overrides,
  };
}

describe("computeProjectSummary", () => {
  it("adds costs and technicians and computes the margin over what was billed", () => {
    const summary = computeProjectSummary(
      input({
        costs: [
          { costDocumentId: "c1", currency: "CLP", amount: 200_000 },
          { costDocumentId: "c2", currency: "CLP", amount: 50_000 },
        ],
        technicianCharges: [{ costDocumentId: "t1", linkedDocumentIds: [], netAmount: 150_000, currency: "CLP" }],
      }),
    );
    expect(summary).toMatchObject({
      quoted: 1_000_000,
      billed: 800_000,
      expenses: 250_000,
      technicians: 150_000,
      margin: 400_000,
      marginPct: 50,
      excluded: [],
    });
  });

  it("counts a technician's cost documents only in Técnicos (own document and linked factura/boleta)", () => {
    const summary = computeProjectSummary(
      input({
        costs: [
          { costDocumentId: "own-doc", currency: "CLP", amount: 100_000 },
          { costDocumentId: "factura", currency: "CLP", amount: 100_000 },
          { costDocumentId: "other-tech-doc", currency: "CLP", amount: 30_000 },
          { costDocumentId: "material", currency: "CLP", amount: 40_000 },
        ],
        technicianCharges: [
          { costDocumentId: "own-doc", linkedDocumentIds: ["factura"], netAmount: 100_000, currency: "CLP" },
        ],
        technicianDocumentIds: new Set(["other-tech-doc"]),
      }),
    );
    expect(summary.expenses).toBe(40_000);
    expect(summary.technicians).toBe(100_000);
    expect(summary.margin).toBe(660_000);
  });

  it("shows no margin percentage when nothing was billed", () => {
    const summary = computeProjectSummary(
      input({ billed: 0, costs: [{ costDocumentId: "c1", currency: "CLP", amount: 10_000 }] }),
    );
    expect(summary.margin).toBe(-10_000);
    expect(summary.marginPct).toBeNull();
  });

  it("rounds the margin percentage to one decimal and keeps negatives", () => {
    const summary = computeProjectSummary(
      input({ billed: 300, currency: "USD", costs: [{ costDocumentId: "c", currency: "USD", amount: 400 }] }),
    );
    expect(summary.margin).toBe(-100);
    expect(summary.marginPct).toBe(-33.3);
  });

  it("never converts: amounts in another currency are left out and reported", () => {
    const summary = computeProjectSummary(
      input({
        currency: "USD",
        billed: 1_000,
        quoted: 1_200,
        costs: [
          { costDocumentId: "usd", currency: "USD", amount: 100.1 },
          { costDocumentId: "usd2", currency: "USD", amount: 0.2 },
          { costDocumentId: "uyu", currency: "UYU", amount: 4_000 },
        ],
        technicianCharges: [
          { costDocumentId: "t", linkedDocumentIds: [], netAmount: 8_000, currency: "UYU" },
          { costDocumentId: "t2", linkedDocumentIds: [], netAmount: 50, currency: "USD" },
        ],
      }),
    );
    expect(summary.expenses).toBe(100.3);
    expect(summary.technicians).toBe(50);
    expect(summary.margin).toBe(849.7);
    expect(summary.excluded).toEqual([
      { kind: "tecnicos", currency: "UYU", amount: 8_000 },
      { kind: "gastos", currency: "UYU", amount: 4_000 },
    ]);
  });

  it("is unknown (null), not zero, when a read failed", () => {
    const noCharges = computeProjectSummary(input({ technicianCharges: null }));
    expect(noCharges.technicians).toBeNull();
    expect(noCharges.expenses).toBeNull();
    expect(noCharges.margin).toBeNull();
    expect(noCharges.marginPct).toBeNull();

    const noCosts = computeProjectSummary(input({ costs: null }));
    expect(noCosts.expenses).toBeNull();
    expect(noCosts.technicians).toBe(0);
    expect(noCosts.margin).toBeNull();
    expect(noCosts.marginPct).toBeNull();
    expect(noCosts.billed).toBe(800_000);

    const noQuote = computeProjectSummary(input({ quoted: null }));
    expect(noQuote.quoted).toBeNull();
    expect(noQuote.margin).toBe(800_000);
  });
});

describe("costAllocationShare", () => {
  it("is a percentage of the document's net, or the fixed amount", () => {
    expect(costAllocationShare({ method: "percentage", percentage: "25", amount: null, documentNet: "1000" })).toBe(250);
    expect(costAllocationShare({ method: "fixed_amount", percentage: null, amount: "300.5", documentNet: 1000 })).toBe(300.5);
  });
});

function rows(overrides: Partial<ProjectSummaryRows> = {}): ProjectSummaryRows {
  return {
    currency: "CLP",
    projectQuotedAmount: 900,
    quoteBilling: [],
    costs: [],
    technicianCharges: [],
    technicianDocumentIds: new Set(),
    ...overrides,
  };
}

describe("projectSummaryFromRows (job page = report = assistant)", () => {
  it("builds the six figures from the database rows", () => {
    const summary = projectSummaryFromRows(
      rows({
        quoteBilling: [
          { quoted_amount: "1000", billed_amount: "600.10" },
          { quoted_amount: null, billed_amount: 200.2 },
        ],
        costs: [
          { id: "material", currency: "CLP", amount: 100 },
          { id: "charge-doc", currency: "CLP", amount: 150 },
          { id: "boleta", currency: "CLP", amount: 150 },
          { id: "other-job-factura", currency: "CLP", amount: 70 },
        ],
        technicianCharges: [
          { cost_document_id: "charge-doc", net_amount: "150", currency: "CLP", document_links: [{ document: { id: "boleta" } }] },
        ],
        technicianDocumentIds: new Set(["boleta", "other-job-factura"]),
      }),
    );
    expect(summary).toEqual({
      currency: "CLP",
      quoted: 1000,
      billed: 800.3,
      expenses: 100,
      technicians: 150,
      margin: 550.3,
      marginPct: 68.8,
      excluded: [],
    });
  });

  it("falls back to the job's quoted amount and bills zero without quotes", () => {
    const summary = projectSummaryFromRows(rows());
    expect(summary).toMatchObject({ quoted: 900, billed: 0, expenses: 0, technicians: 0, margin: 0, marginPct: null });
  });

  it("leaves gastos, técnicos and margen unknown when the charges or their documents were not read", () => {
    for (const broken of [rows({ technicianCharges: null }), rows({ technicianDocumentIds: null }), rows({ costs: null })]) {
      const summary = projectSummaryFromRows({ ...broken, quoteBilling: [{ quoted_amount: 10, billed_amount: 5 }] });
      expect(summary.billed).toBe(5);
      expect(summary.expenses).toBeNull();
      expect(summary.margin).toBeNull();
      expect(summary.marginPct).toBeNull();
    }
    expect(projectSummaryFromRows(rows({ technicianDocumentIds: null })).technicians).toBeNull();
  });
});

describe("totalProjectSummaries (client, area, month, company)", () => {
  const job = (overrides: Partial<ProjectSummary>): ProjectSummary => ({
    currency: "UYU",
    quoted: 0,
    billed: 0,
    expenses: 0,
    technicians: 0,
    margin: 0,
    marginPct: null,
    excluded: [],
    ...overrides,
  });
  // 1 USD = 40 UYU in 2026-10, 50 in 2026-11; no rate for CLP.
  const convert = (amount: number, from: string, date: string) =>
    from === "USD" ? amount * (date.startsWith("2026-11") ? 50 : 40) : null;

  it("adds jobs of the company's currency as they are, without flagging a conversion", () => {
    const totals = totalProjectSummaries(
      [
        { summary: job({ quoted: 1000, billed: 800, expenses: 200, technicians: 100, margin: 500 }), date: "2026-10-05" },
        { summary: job({ quoted: null, billed: 200, expenses: 300, technicians: 0, margin: -100 }), date: "2026-11-05" },
      ],
      "UYU",
      convert,
    );
    expect(totals).toEqual({
      currency: "UYU",
      jobs: 2,
      quoted: 1000,
      billed: 1000,
      expenses: 500,
      technicians: 100,
      margin: 400,
      marginPct: 40,
      converted: false,
      unconverted: [],
      unknownJobs: 0,
    });
  });

  it("converts a job in another currency, and what its cards left out, with the rate of the job's date", () => {
    const totals = totalProjectSummaries(
      [
        { summary: job({ currency: "USD", quoted: 100, billed: 80, expenses: 10, technicians: 5, margin: 65 }), date: "2026-10-05" },
        {
          summary: job({
            billed: 10_000,
            expenses: 1_000,
            excluded: [
              { kind: "gastos", currency: "USD", amount: 20 },
              { kind: "tecnicos", currency: "USD", amount: 4 },
            ],
          }),
          date: "2026-11-20",
        },
      ],
      "UYU",
      convert,
    );
    expect(totals).toMatchObject({
      quoted: 4_000,
      billed: 13_200,
      expenses: 400 + 1_000 + 1_000,
      technicians: 200 + 200,
      margin: 13_200 - 2_400 - 400,
      converted: true,
      unconverted: [],
    });
    expect(totals.marginPct).toBe(78.8);
  });

  it("leaves out what has no exchange rate and says how much, never 1:1", () => {
    const totals = totalProjectSummaries(
      [
        { summary: job({ currency: "CLP", quoted: 500, billed: 300, expenses: 100, technicians: 0, margin: 200 }), date: "2026-10-05" },
        { summary: job({ billed: 1_000, excluded: [{ kind: "gastos", currency: "CLP", amount: 50 }] }), date: "2026-10-05" },
      ],
      "UYU",
      convert,
    );
    expect(totals).toMatchObject({ quoted: 0, billed: 1_000, expenses: 0, margin: 1_000, converted: false });
    expect(totals.unconverted).toEqual([
      { kind: "cotizado", currency: "CLP", amount: 500 },
      { kind: "facturado", currency: "CLP", amount: 300 },
      { kind: "gastos", currency: "CLP", amount: 150 },
    ]);
  });

  it("counts the jobs with an unknown figure instead of passing them for zero", () => {
    const totals = totalProjectSummaries(
      [
        { summary: job({ billed: 500, expenses: null, technicians: null, margin: null }), date: "2026-10-05" },
        { summary: job({ billed: 100, expenses: 40, margin: 60 }), date: "2026-10-05" },
      ],
      "UYU",
      convert,
    );
    expect(totals).toMatchObject({ billed: 600, expenses: 40, unknownJobs: 1 });
  });

  it("has no margin percentage when nothing positive was billed", () => {
    const totals = totalProjectSummaries([{ summary: job({ expenses: 10, margin: -10 }), date: "2026-10-05" }], "UYU", convert);
    expect(totals).toMatchObject({ margin: -10, marginPct: null });
  });
});
