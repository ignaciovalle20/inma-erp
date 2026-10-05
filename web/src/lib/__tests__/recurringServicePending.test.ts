/**
 * Pure helpers behind the recurring-services Pendientes screen and list
 * badges (plan-servicios-recurrentes.md, Phase 5).
 */
import { describe, it, expect } from "vitest";
import {
  bulkMarkCounts,
  cyclesBeforeStart,
  needsLinkReview,
  periodEnd,
  boardBadge,
  boardMonthOf,
  clampMonth,
  compareByDueDate,
  debtByClient,
  describeAge,
  formatDueDate,
  groupForBoard,
  shiftMonth,
  totalsByCurrency,
  formatPeriod,
  groupByServiceType,
  isOverdue,
  nextActionLabel,
  relevantDueDate,
  splitByOverdue,
  todayForCountry,
} from "@/lib/recurringServicePending";
import { currenciesForCountry, resolveServiceCurrency, serviceCountry } from "@/lib/recurringServiceTypes";

const occ = (
  status: string,
  invoice_due_date: string | null,
  collection_due_date: string | null = invoice_due_date,
  service_type: string | null = "hosting",
  name = "x",
) => ({ status, invoice_due_date, collection_due_date, service_type, name });

describe("todayForCountry", () => {
  // 2026-09-23 01:30 UTC is still the 22nd in Chile and Uruguay.
  const lateEvening = new Date("2026-09-23T01:30:00Z");

  it("uses the company's local date, not UTC", () => {
    expect(todayForCountry("CL", lateEvening)).toBe("2026-09-22");
    expect(todayForCountry("UY", lateEvening)).toBe("2026-09-22");
  });

  it("falls back to Uruguay's time zone for an unknown or missing country", () => {
    expect(todayForCountry(null, lateEvening)).toBe("2026-09-22");
    expect(todayForCountry("AR", new Date("2026-09-23T12:00:00Z"))).toBe("2026-09-23");
  });
});

describe("relevantDueDate / isOverdue", () => {
  it("uses the invoice due date until invoiced, then the collection due date", () => {
    expect(relevantDueDate(occ("pending_invoice", "2026-09-10", "2026-09-30"))).toBe("2026-09-10");
    expect(relevantDueDate(occ("invoiced", "2026-09-10", "2026-09-30"))).toBe("2026-09-30");
    expect(relevantDueDate(occ("invoiced", "2026-09-10", null))).toBe("2026-09-10");
  });

  it("is overdue only strictly after the due date, and never without one", () => {
    expect(isOverdue(occ("pending_invoice", "2026-09-21"), "2026-09-22")).toBe(true);
    expect(isOverdue(occ("pending_invoice", "2026-09-22"), "2026-09-22")).toBe(false);
    expect(isOverdue(occ("pending_invoice", null), "2026-09-22")).toBe(false);
  });
});

describe("groupByServiceType", () => {
  it("groups in the board's column order, untyped last, each sorted by due date with undated last", () => {
    const groups = groupByServiceType(
      [
        occ("pending_invoice", null, null, "hosting", "h-undated"),
        occ("pending_invoice", "2026-09-20", null, "hosting", "h-20"),
        occ("pending_invoice", "2026-09-05", null, null, "untyped"),
        occ("invoiced", "2026-08-01", "2026-09-01", "ms_licenses", "ms"),
        occ("pending_invoice", "2026-09-10", null, "hosting", "h-10"),
        occ("pending_invoice", "2026-09-01", null, "made-up-type", "unknown"),
      ],
      compareByDueDate,
    );

    expect(groups.map((g) => g.label)).toEqual(["Licencias MS", "Hosting", "Sin tipo especificado"]);
    expect(groups[1].rows.map((r) => r.name)).toEqual(["h-10", "h-20", "h-undated"]);
    expect(groups[2].rows.map((r) => r.name)).toEqual(["unknown", "untyped"]);
  });
});

describe("formatting", () => {
  it("formats periods by periodicity without timezone drift", () => {
    expect(formatPeriod("2026-01-01", "monthly")).toBe("ene 2026");
    expect(formatPeriod("2026-12-01", "monthly")).toBe("dic 2026");
    expect(formatPeriod("2026-01-01", "annual")).toBe("2026");
  });

  it("formats due dates as dd/mm/yyyy, or says there is none", () => {
    expect(formatDueDate("2026-02-28")).toBe("28/02/2026");
    expect(formatDueDate(null)).toBe("sin fecha");
  });

  it("labels the next one-tap action", () => {
    expect(nextActionLabel("pending_invoice")).toBe("Facturar");
    expect(nextActionLabel("invoiced")).toBe("Cobrar");
    expect(nextActionLabel("collected")).toBeNull();
  });
});

describe("country and currency of a service", () => {
  it("takes the country from the company, case-insensitively", () => {
    expect(serviceCountry("CL")).toBe("CL");
    expect(serviceCountry("uy")).toBe("UY");
    expect(serviceCountry(null)).toBeNull();
    expect(serviceCountry("AR")).toBeNull();
  });

  it("Chile is always CLP; Uruguay must pick USD or UYU; no country keeps the old choice", () => {
    expect(currenciesForCountry("CL")).toEqual(["CLP"]);
    expect(resolveServiceCurrency("CL", "USD")).toBe("CLP");
    expect(resolveServiceCurrency("CL", undefined)).toBe("CLP");
    expect(currenciesForCountry("UY")).toEqual(["USD", "UYU"]);
    expect(resolveServiceCurrency("UY", "UYU")).toBe("UYU");
    expect(resolveServiceCurrency("UY", "CLP")).toBeNull();
    expect(resolveServiceCurrency("UY", "")).toBeNull();
    expect(resolveServiceCurrency(null, "CLP")).toBe("CLP");
  });
});

describe("month board", () => {
  const cycle = (overrides: Partial<Parameters<typeof boardMonthOf>[0]>) => ({
    invoice_due_date: null,
    period: "2026-09-01",
    service_periodicity: "monthly",
    service_invoicing_mode: "advance",
    service_due_month: null,
    ...overrides,
  });

  it("puts a cycle in the month it is due", () => {
    expect(boardMonthOf(cycle({ invoice_due_date: "2026-10-05", service_invoicing_mode: "arrears" }))).toBe("2026-10");
    // Without a due date: anticipado = its period, vencido = the month after, annual = its due month.
    expect(boardMonthOf(cycle({}))).toBe("2026-09");
    expect(boardMonthOf(cycle({ service_invoicing_mode: "arrears" }))).toBe("2026-10");
    expect(boardMonthOf(cycle({ period: "2026-12-01", service_invoicing_mode: "arrears" }))).toBe("2027-01");
    expect(boardMonthOf(cycle({ period: "2026-01-01", service_periodicity: "annual", service_due_month: 11 }))).toBe("2026-11");
  });

  it("navigates months and keeps them within bounds", () => {
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(shiftMonth("2026-09", -1)).toBe("2026-08");
    expect(clampMonth("2026-05", "2026-09", "2026-11")).toBe("2026-09");
    expect(clampMonth("2027-05", "2026-09", "2026-11")).toBe("2026-11");
    expect(clampMonth("2026-10", "2026-09", "2026-11")).toBe("2026-10");
  });

  it("groups like Planner: Hosting, Licencias MS, Starlink/Servidor together, then the rest", () => {
    const groups = groupForBoard(
      [
        { service_type: "server", name: "srv" },
        { service_type: "ms_licenses", name: "ms" },
        { service_type: "starlink", name: "sl" },
        { service_type: null, name: "none" },
        { service_type: "hosting", name: "h" },
      ],
      (a, b) => a.name.localeCompare(b.name),
    );
    expect(groups.map((g) => [g.label, g.rows.map((r) => r.name)])).toEqual([
      ["Hosting", ["h"]],
      ["Licencias MS", ["ms"]],
      ["Starlink / Servidor", ["sl", "srv"]],
      ["Otros", ["none"]],
    ]);
  });

  it("badges and overdue: red only while not collected", () => {
    expect(boardBadge("pending_invoice").label).toBe("Facturar");
    expect(boardBadge("invoiced").label).toBe("Cobrar");
    expect(boardBadge("pending_collection").label).toBe("Cobrar");
    expect(boardBadge("collected").label).toBe("Pagado");
    expect(isOverdue(occ("collected", "2026-09-01"), "2026-09-22")).toBe(false);
    expect(isOverdue(occ("void", "2026-09-01"), "2026-09-22")).toBe(false);
    expect(isOverdue(occ("pending_collection", "2026-09-01"), "2026-09-22")).toBe(true);
  });

  it("totals per currency, never mixing CLP, USD and UYU, ignoring voided cycles", () => {
    expect(
      totalsByCurrency([
        { status: "pending_invoice", amount: 100, currency: "USD" },
        { status: "invoiced", amount: 1000, currency: "CLP" },
        { status: "pending_collection", amount: 500, currency: "CLP" },
        { status: "collected", amount: 50, currency: "USD" },
        { status: "void", amount: 999, currency: "CLP" },
        { status: "collected", amount: 7, currency: "UYU" },
      ]),
    ).toEqual([
      { currency: "CLP", toInvoice: 0, toCollect: 1500, collected: 0 },
      { currency: "USD", toInvoice: 100, toCollect: 0, collected: 50 },
      { currency: "UYU", toInvoice: 0, toCollect: 0, collected: 7 },
    ]);
  });
});

describe("Deuda", () => {
  const debt = (client: string, status: string, due: string | null, amount: number, currency = "CLP") => ({
    ...occ(status, due),
    client_id: client,
    client_name: `Cliente ${client}`,
    amount,
    currency,
  });

  it("groups open cycles by client, oldest debt first, with per-currency subtotals", () => {
    const groups = debtByClient([
      debt("b", "invoiced", "2026-09-05", 100),
      debt("a", "pending_invoice", "2026-10-05", 10, "USD"),
      debt("b", "pending_invoice", "2026-10-05", 50),
      debt("a", "collected", "2026-08-05", 999),
      debt("a", "pending_collection", "2026-10-01", 20, "UYU"),
    ]);
    expect(groups.map((g) => g.clientName)).toEqual(["Cliente b", "Cliente a"]);
    expect(groups[0].totals).toEqual([{ currency: "CLP", amount: 150 }]);
    expect(groups[1].rows.map((r) => r.status)).toEqual(["pending_collection", "pending_invoice"]);
    expect(groups[1].totals).toEqual([
      { currency: "USD", amount: 10 },
      { currency: "UYU", amount: 20 },
    ]);
  });

  describe("Vencido / Por vencer on 3/10/2026 (QA fase 2b: Trimant and Fabian, mes vencido, USD)", () => {
    const today = "2026-10-03";
    const cycles = [
      { ...debt("trimant", "pending_invoice", "2026-09-05", 100, "USD"), name: "Trimant sep" },
      { ...debt("fabian", "pending_invoice", "2026-09-10", 100, "USD"), name: "Fabian sep" },
      { ...debt("trimant", "pending_invoice", "2026-10-05", 100, "USD"), name: "Trimant oct" },
      { ...debt("fabian", "pending_invoice", "2026-10-10", 100, "USD"), name: "Fabian oct" },
    ];

    it("September cycles are overdue, October ones (due 05/10 and 10/10) are upcoming", () => {
      const { overdue, upcoming } = splitByOverdue(cycles, today);
      expect(overdue.map((c) => c.name)).toEqual(["Trimant sep", "Fabian sep"]);
      expect(upcoming.map((c) => c.name)).toEqual(["Trimant oct", "Fabian oct"]);
    });

    it("each block keeps its own per-currency totals and client grouping", () => {
      const { overdue, upcoming } = splitByOverdue(cycles, today);
      expect(totalsByCurrency(overdue)).toEqual([{ currency: "USD", toInvoice: 200, toCollect: 0, collected: 0 }]);
      expect(debtByClient(overdue).map((g) => [g.clientName, g.totals])).toEqual([
        ["Cliente trimant", [{ currency: "USD", amount: 100 }]],
        ["Cliente fabian", [{ currency: "USD", amount: 100 }]],
      ]);
      expect(debtByClient(upcoming).map((g) => g.clientName)).toEqual(["Cliente trimant", "Cliente fabian"]);
    });

    it("due today is not overdue yet; undated cycles are upcoming; collected and void are in neither", () => {
      const { overdue, upcoming } = splitByOverdue(
        [
          { ...debt("a", "pending_invoice", today, 1), name: "hoy" },
          { ...debt("a", "pending_collection", null, 1), name: "sin fecha" },
          { ...debt("a", "invoiced", "2026-10-02", 1), name: "ayer facturado" },
          { ...debt("a", "collected", "2026-09-01", 1), name: "cobrado" },
          { ...debt("a", "void", "2026-09-01", 1), name: "anulado" },
        ],
        today,
      );
      expect(overdue.map((c) => c.name)).toEqual(["ayer facturado"]);
      expect(upcoming.map((c) => c.name)).toEqual(["hoy", "sin fecha"]);
    });

    it("the month summary tells the overdue part apart, per currency", () => {
      const rows = [
        ...cycles,
        { ...debt("omega", "pending_invoice", "2026-09-30", 2000, "UYU"), name: "Omega" },
        { ...debt("razo", "collected", "2026-09-10", 50, "USD"), name: "cobrado vencido" },
      ];
      expect(totalsByCurrency(rows, today)).toEqual([
        { currency: "USD", toInvoice: 400, toCollect: 0, collected: 50, overdue: 200 },
        { currency: "UYU", toInvoice: 2000, toCollect: 0, collected: 0, overdue: 2000 },
      ]);
    });
  });

  it("describes how old a debt is", () => {
    expect(describeAge("2026-09-20", "2026-09-22")).toBe("vencido hace 2 días");
    expect(describeAge("2026-09-21", "2026-09-22")).toBe("vencido hace 1 día");
    expect(describeAge("2026-09-22", "2026-09-22")).toBe("vence hoy");
    expect(describeAge("2026-09-25", "2026-09-22")).toBe("vence en 3 días");
    expect(describeAge(null, "2026-09-22")).toBe("sin vencimiento");
  });
});

describe("retroactive cycles helpers", () => {
  it("periodEnd: last day of the month, or of the year for annual", () => {
    expect(periodEnd("2026-02-01", "monthly")).toBe("2026-02-28");
    expect(periodEnd("2028-02-01", "monthly")).toBe("2028-02-29");
    expect(periodEnd("2026-12-01", "monthly")).toBe("2026-12-31");
    expect(periodEnd("2026-01-01", "annual")).toBe("2026-12-31");
  });

  it("cyclesBeforeStart: whole period before the start, voided ones ignored", () => {
    const cycles = [
      { period: "2026-04-01", status: "collected" },
      { period: "2026-05-01", status: "pending_invoice" },
      { period: "2026-05-01", status: "void" },
      { period: "2026-06-01", status: "pending_invoice" }, // the start month itself stays
    ];
    const result = cyclesBeforeStart(cycles, "2026-06-15", "monthly");
    expect(result.all.map((c) => c.status)).toEqual(["collected", "pending_invoice"]);
    expect(result.open.map((c) => c.period)).toEqual(["2026-05-01"]);
  });

  it("bulkMarkCounts: by due month, inclusive", () => {
    const cycles = [
      { status: "pending_invoice", invoice_due_date: "2026-03-05", period: "2026-03-01" },
      { status: "invoiced", invoice_due_date: "2026-04-05", period: "2026-04-01" },
      { status: "collected", invoice_due_date: "2026-05-05", period: "2026-05-01" },
      { status: "pending_invoice", invoice_due_date: "2026-06-05", period: "2026-06-01" },
    ];
    expect(bulkMarkCounts(cycles, "2026-05")).toEqual({ invoice: 1, collect: 2 });
    expect(bulkMarkCounts(cycles, "2026-06")).toEqual({ invoice: 2, collect: 3 });
  });

  it("needsLinkReview: flagged and still unlinked", () => {
    expect(needsLinkReview({ link_review: "no_match", sales_document_id: null })).toBe(true);
    expect(needsLinkReview({ link_review: "multiple", sales_document_id: null })).toBe(true);
    expect(needsLinkReview({ link_review: "multiple", sales_document_id: "doc" })).toBe(false);
    expect(needsLinkReview({ link_review: "dismissed", sales_document_id: null })).toBe(false);
    expect(needsLinkReview({ link_review: null, sales_document_id: null })).toBe(false);
  });
});
