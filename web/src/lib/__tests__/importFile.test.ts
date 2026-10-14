/**
 * The generic importers read CSV and Excel alike: headers from the first
 * non-empty row, every value as text in the shapes the parsers expect.
 */
import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { parseTabularFile } from "@/lib/importFile";

describe("parseTabularFile", () => {
  it("reads an .xlsx: dates, decimals, formulas and an empty header", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Ventas");
    sheet.addRow([]);
    sheet.addRow(["Fecha", "N° doc", "Cliente", "Neto", ""]);
    sheet.addRow([new Date(Date.UTC(2026, 8, 15)), 1001, "Cliente Uno", 1234.5, "x"]);
    sheet.addRow([new Date(Date.UTC(2026, 8, 16)), 1002, "Cliente Dos", { formula: "1000+500", result: 1500 }, ""]);
    const buffer = await workbook.xlsx.writeBuffer();
    const file = new File([buffer as ArrayBuffer], "ventas.xlsx");

    const table = await parseTabularFile(file);
    expect(table).toEqual({
      headers: ["Fecha", "N° doc", "Cliente", "Neto", "Columna 5"],
      rows: [
        { Fecha: "2026-09-15", "N° doc": "1001", Cliente: "Cliente Uno", Neto: "1234.5", "Columna 5": "x" },
        { Fecha: "2026-09-16", "N° doc": "1002", Cliente: "Cliente Dos", Neto: "1500", "Columna 5": "" },
      ],
    });
  });

  it("reads a CSV with ; and a BOM", async () => {
    const file = new File(["﻿Fecha;Cliente;Neto\n15/09/2026;Cliente Uno;1.234,50\n"], "ventas.csv", { type: "text/csv" });
    expect(await parseTabularFile(file)).toEqual({
      headers: ["Fecha", "Cliente", "Neto"],
      rows: [{ Fecha: "15/09/2026", Cliente: "Cliente Uno", Neto: "1.234,50" }],
    });
  });

  it("says what is wrong with an old .xls or an empty file", async () => {
    expect(await parseTabularFile(new File(["x"], "viejo.xls"))).toEqual({ error: expect.stringMatching(/\.xlsx o \.csv/) });
    expect(await parseTabularFile(new File(["Fecha;Cliente\n"], "vacio.csv"))).toEqual({
      error: "El archivo no tiene filas para importar.",
    });
  });
});
