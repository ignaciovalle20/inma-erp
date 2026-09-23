/**
 * Pure helpers behind the recurring-services Pendientes screen and list
 * badges (plan-servicios-recurrentes.md, Phase 5).
 */
import { describe, it, expect } from "vitest";
import {
  compareByDueDate,
  formatDueDate,
  formatPeriod,
  groupByServiceType,
  isOverdue,
  nextActionLabel,
  relevantDueDate,
  todayForCountry,
} from "@/lib/recurringServicePending";

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
