/**
 * Purchase-invoice rows of the costs import (lib/purchaseImport.ts), with
 * the columns of the Nubox purchases export. Amounts are those of real
 * document shapes found in the export (exempt invoices, exempt credit notes,
 * boletas de honorarios, facturas de compra); no names or RUTs.
 */
import { describe, it, expect } from "vitest";
import {
  purchaseRowCells,
  resolvePurchaseRow,
  signedTotal,
  type PurchaseColumnMapping,
} from "@/lib/purchaseImport";

const NUBOX_MAPPING: PurchaseColumnMapping = {
  amount: "Neto",
  exempt: "Exento",
  tax: "IVA",
  otherTaxes: "Otros impuestos",
  total: "Total",
  documentType: "Tipo documento",
  documentNumber: "Nº documento",
  status: "Estado",
};

function nuboxRow(values: {
  type: string;
  net: string;
  exempt?: string;
  tax?: string;
  other?: string;
  total: string;
  status?: string;
  number?: string;
}) {
  return {
    "Fecha emisión": "01/10/2026",
    "Tipo documento": values.type,
    "Nº documento": values.number ?? "1001",
    "RUT proveedor": "11111111-1",
    Proveedor: "Proveedor de prueba",
    Neto: values.net,
    Exento: values.exempt ?? "0",
    IVA: values.tax ?? "0",
    "Otros impuestos": values.other ?? "0",
    Total: values.total,
    Estado: values.status ?? "Aceptado",
  };
}

const resolve = (row: Record<string, string>, mapping: PurchaseColumnMapping = NUBOX_MAPPING) =>
  resolvePurchaseRow(purchaseRowCells(row, mapping));

describe("resolvePurchaseRow: Nubox purchases export", () => {
  it("imports a factura exenta (Neto 0, everything in Exento) with net = Exento", () => {
    const result = resolve(nuboxRow({ type: "FAC-EE", net: "0", exempt: "105263", total: "105263" }));
    expect(result.error).toBeNull();
    expect(result.amounts).toEqual({
      documentType: "invoice",
      sourceDocumentType: "FAC-EE",
      documentNumber: "1001",
      netAmount: 105263,
      exemptAmount: 105263,
      taxAmount: 0,
      otherTaxes: 0,
      totalAmount: 105263,
    });
  });

  it("imports a 100% exempt credit note that subtracts its Exento", () => {
    const result = resolve(nuboxRow({ type: "N/C-EL", net: "0", exempt: "35319", total: "35319" }));
    expect(result.error).toBeNull();
    expect(result.amounts?.documentType).toBe("credit_note");
    expect(result.amounts?.netAmount).toBe(35319);
    expect(signedTotal(result.amounts!)).toBe(-35319);
  });

  it("leaves a normal factura as before (Neto + IVA = Total)", () => {
    const result = resolve(nuboxRow({ type: "FAC-EL", net: "403695", tax: "76702", total: "480397" }));
    expect(result.error).toBeNull();
    expect(result.amounts).toMatchObject({
      documentType: "invoice",
      netAmount: 403695,
      exemptAmount: 0,
      taxAmount: 76702,
      otherTaxes: 0,
      totalAmount: 480397,
    });
  });

  it("adds the exempt part of a partly exempt factura to its net", () => {
    const result = resolve(nuboxRow({ type: "FAC-EL", net: "9235", exempt: "4000", tax: "1755", total: "14990" }));
    expect(result.amounts).toMatchObject({ netAmount: 13235, exemptAmount: 4000, taxAmount: 1755, totalAmount: 14990 });
  });

  it("keeps Otros impuestos apart from the net and inside the total", () => {
    const result = resolve(nuboxRow({ type: "FAC-EL", net: "100000", tax: "19000", other: "31500", total: "150500" }));
    expect(result.amounts).toMatchObject({ netAmount: 100000, taxAmount: 19000, otherTaxes: 31500, totalAmount: 150500 });
  });

  it("rejects a row whose Neto + Exento + IVA + Otros is not the Total, saying by how much", () => {
    const result = resolve(nuboxRow({ type: "FAC-EL", net: "45805", tax: "8703", other: "1", total: "54096" }));
    expect(result.amounts).toBeNull();
    expect(result.error).toBe(
      'Total "54096" no cuadra con Neto + Exento + IVA + Otros impuestos (54509, diferencia -413)',
    );
  });

  it("accepts the 1-peso rounding of a total (stored as the sum of its parts)", () => {
    const result = resolve(nuboxRow({ type: "N/C-EL", net: "39495", tax: "7504", total: "47000" }));
    expect(result.error).toBeNull();
    expect(result.amounts?.totalAmount).toBe(46999);
  });

  it("says which columns are zero instead of 'Invalid or missing amount'", () => {
    const result = resolve(nuboxRow({ type: "FAC-EL", net: "0", exempt: "0", total: "0" }));
    expect(result.error).toBe('Neto y Exento en 0 (Neto "0", Exento "0")');
  });

  it("names the column and the value it cannot read", () => {
    const result = resolve(nuboxRow({ type: "FAC-EL", net: "abc", total: "100" }));
    expect(result.error).toMatch(/^Neto inválido "abc"/);
  });

  it("reports an unsupported document type with the supported list", () => {
    const result = resolve(nuboxRow({ type: "DIN", net: "1000", total: "1000" }));
    expect(result.error).toMatch(/^Tipo de documento no soportado: Tipo documento "DIN" \(se importan FAC-EL, FAC-EE/);
  });

  it("does not import an annulled document", () => {
    const result = resolve(nuboxRow({ type: "BOL-HE", net: "500000", total: "423750", status: "Anulada" }));
    expect(result.error).toBe('Documento con Estado "Anulada": no se importa');
  });

  it("imports a boleta de honorarios at its gross (Neto), the retención is the difference to Total", () => {
    const result = resolve(nuboxRow({ type: "BOL-HE", net: "350877", total: "300000", status: "Válido" }));
    expect(result.amounts).toMatchObject({ documentType: "invoice", netAmount: 350877, taxAmount: 0, totalAmount: 350877 });
  });

  it("rejects a boleta whose líquido is above the gross", () => {
    const result = resolve(nuboxRow({ type: "BOL-TE", net: "100000", total: "115942" }));
    expect(result.error).toMatch(/^Total "115942" no cuadra con la boleta/);
  });

  it("imports a factura de compra with the IVA withheld (Total = Neto) with its IVA", () => {
    const result = resolve(nuboxRow({ type: "FAC-CE", net: "75000", tax: "14250", total: "75000" }));
    expect(result.amounts).toMatchObject({ netAmount: 75000, taxAmount: 14250, totalAmount: 89250 });
  });

  it("imports a nota de débito as a cost that adds", () => {
    const result = resolve(nuboxRow({ type: "N/D-EL", net: "1000", tax: "190", total: "1190" }));
    expect(result.amounts?.documentType).toBe("invoice");
  });

  it("reads a credit note written with negative amounts as the same credit note", () => {
    const result = resolve(nuboxRow({ type: "N/C-EL", net: "-1000", tax: "-190", total: "-1190" }));
    expect(result.amounts).toMatchObject({ documentType: "credit_note", netAmount: 1000, taxAmount: 190, totalAmount: 1190 });
  });

  it("rejects a negative amount on an invoice", () => {
    const result = resolve(nuboxRow({ type: "FAC-EL", net: "-1000", total: "-1000" }));
    expect(result.error).toMatch(/^Neto "-1000" es negativo/);
  });
});

describe("resolvePurchaseRow: generic CSV (only Neto and IVA mapped)", () => {
  const mapping: PurchaseColumnMapping = {
    amount: "monto",
    exempt: null,
    tax: "iva",
    otherTaxes: null,
    total: null,
    documentType: null,
    documentNumber: null,
    status: null,
  };

  it("reads an invoice of Neto + IVA, as before", () => {
    const result = resolve({ monto: "1.234,50", iva: "234,56" }, mapping);
    expect(result.amounts).toMatchObject({
      documentType: "invoice",
      sourceDocumentType: null,
      documentNumber: null,
      netAmount: 1234.5,
      taxAmount: 234.56,
      totalAmount: 1469.06,
    });
  });

  it("still rejects a missing amount, naming the column", () => {
    expect(resolve({ monto: "", iva: "" }, mapping).error).toBe('monto "vacío": falta el importe o es 0');
  });
});
