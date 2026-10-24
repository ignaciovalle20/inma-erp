/**
 * "Eliminar" on an expense: what the confirmation names it by, where a
 * technician's charge is sent instead, and where the action may go back to.
 */
import { describe, it, expect } from "vitest";
import {
  allocatedShareNote,
  costDeletionSummary,
  safeRedirect,
  technicianChargeHref,
  technicianChargeHrefs,
} from "@/lib/costDocumentDeletion";

describe("cost document deletion", () => {
  it("names the expense by description, supplier and date, skipping what is missing", () => {
    expect(costDeletionSummary({ description: "Cables", supplierName: "Sodimac", date: "2026-10-06" })).toBe(
      "Cables · Sodimac · 2026-10-06",
    );
    expect(costDeletionSummary({ description: "  ", supplierName: null, date: "2026-10-06" })).toBe("2026-10-06");
  });

  it("sends a technician's charge to Corregir in its job's Técnicos section", () => {
    expect(technicianChargeHref("c1", { id: "ch1", project_id: "p1" })).toBe(
      "/companies/c1/projects/p1/technician-charges/ch1/edit",
    );
    const hrefs = technicianChargeHrefs("c1", [{ id: "ch1", project_id: "p1", cost_document_id: "d1" }]);
    expect(hrefs.get("d1")).toBe("/companies/c1/projects/p1/technician-charges/ch1/edit");
    expect(hrefs.get("d2")).toBeUndefined();
  });

  it("only goes back to a page of the same company", () => {
    expect(safeRedirect("c1", "/companies/c1/projects/p1")).toBe("/companies/c1/projects/p1");
    expect(safeRedirect("c1", "/companies/c1/costs")).toBe("/companies/c1/costs");
    expect(safeRedirect("c1", "/companies/c2/costs")).toBeNull();
    expect(safeRedirect("c1", "https://example.com/companies/c1/")).toBeNull();
    expect(safeRedirect("c1", "/companies/c1//evil.com")).toBeNull();
    expect(safeRedirect("c1", null)).toBeNull();
  });

  it("warns that a split general cost goes as a whole", () => {
    expect(allocatedShareNote("300.000 CLP")).toMatch(/documento completo \(300\.000 CLP\)/);
  });
});
