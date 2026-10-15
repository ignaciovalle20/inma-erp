import { describe, it, expect } from "vitest";
import { buildSalesCsv, type SalesExportRow } from "@/lib/salesExport";

function row(overrides: Partial<SalesExportRow> = {}): SalesExportRow {
  return {
    documentDate: "2026-08-10",
    documentType: "invoice",
    documentNumber: "1001",
    clientName: "Cliente Uno SpA",
    areaName: "Soporte",
    projectName: "Soporte agosto",
    netAmount: 100000,
    cost: 40000,
    profit: 60000,
    marginPct: 60,
    paymentStatus: "impago",
    dueDate: "2026-09-10",
    annulledBy: null,
    voided: false,
    ...overrides,
  };
}

describe("buildSalesCsv", () => {
  it("starts with a BOM and uses ; with CRLF line breaks", () => {
    const csv = buildSalesCsv([row()]);
    expect(csv.startsWith("﻿")).toBe(true);
    const lines = csv.trimEnd().split("\r\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('"Fecha";"Documento";"Folio"');
  });

  it("formats dates dd/mm/aaaa, the payment status label and a decimal comma", () => {
    const [, data] = buildSalesCsv([row({ marginPct: 12.5 })]).trimEnd().split("\r\n");
    const cells = data.split(";").map((c) => c.replace(/^"|"$/g, ""));
    expect(cells[0]).toBe("10/08/2026");
    expect(cells[1]).toBe("Factura");
    expect(cells[6]).toBe("100000");
    expect(cells[9]).toBe("12,5");
    expect(cells[10]).toBe("Impaga");
    expect(cells[11]).toBe("10/09/2026");
  });

  it("exports a credit note as a negative net", () => {
    const [, data] = buildSalesCsv([row({ documentType: "credit_note", netAmount: 86000 })]).trimEnd().split("\r\n");
    expect(data.split(";")[6]).toBe('"-86000"');
  });

  it("leaves cost, profit and margin empty when the sale has no job", () => {
    const [, data] = buildSalesCsv([row({ cost: null, profit: null, marginPct: null, projectName: null })])
      .trimEnd()
      .split("\r\n");
    const cells = data.split(";");
    expect(cells.slice(7, 10)).toEqual(['""', '""', '""']);
  });

  it("escapes quotes and neutralizes formulas in names", () => {
    const [, data] = buildSalesCsv([row({ clientName: 'Acme "Sur"', projectName: "=HYPERLINK(1)" })])
      .trimEnd()
      .split("\r\n");
    expect(data).toContain('"Acme ""Sur"""');
    expect(data).toContain(`"'=HYPERLINK(1)"`);
  });

  it("keeps the cents of a USD net and says the currency and the payment date", () => {
    const [header, data] = buildSalesCsv([
      row({ currency: "USD", netAmount: 1234.5, paymentStatus: "pagado", paidAt: "2026-09-01" }),
    ])
      .trimEnd()
      .split("\r\n");
    const cells = data.split(";").map((c) => c.replace(/^"|"$/g, ""));
    expect(header).toContain('"Moneda";"Fecha de pago"');
    expect(cells[6]).toBe("1234,50");
    expect(cells[10]).toBe("Pagada");
    expect(cells.slice(-2)).toEqual(["USD", "01/09/2026"]);
  });

  it("marks an annulled document and says by which one", () => {
    const [, data] = buildSalesCsv([row({ voided: true, annulledBy: "358" })]).trimEnd().split("\r\n");
    expect(data).toContain("Sí (N/C o factura 358)");
  });
});
