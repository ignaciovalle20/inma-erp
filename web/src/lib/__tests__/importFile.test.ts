/**
 * The generic importers read CSV and Excel alike: headers from the first
 * non-empty row, every value as text in the shapes the parsers expect.
 */
import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { parseTabularFile, readTextFile } from "@/lib/importFile";

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

  it("skips the preamble an export opens with (date range, filter, blank) and finds the header row", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Sheet0");
    sheet.addRow([new Date(Date.UTC(2026, 3, 1)), "al"]);
    sheet.addRow(["Filter", "cliente"]);
    sheet.addRow([]);
    sheet.addRow(["Fecha", "Tipo", "Nº", "Estado DGI", "Cliente", "Moneda", "Total", "Saldo"]);
    sheet.addRow([new Date(Date.UTC(2026, 10, 4)), "Venta Contado", 13840, null, "Cliente Uno S.A.", "$  ", 6832, 0]);
    sheet.addRow([new Date(Date.UTC(2026, 9, 10)), "Venta Contado", 13791, "Aceptado", "Cliente Uno S.A.", "U$S", 340.5, 0]);
    const buffer = await workbook.xlsx.writeBuffer();

    const table = await parseTabularFile(new File([buffer as ArrayBuffer], "VentasExport.xlsx"));
    if ("error" in table) throw new Error(table.error);
    expect(table.headers).toEqual(["Fecha", "Tipo", "Nº", "Estado DGI", "Cliente", "Moneda", "Total", "Saldo"]);
    expect(table.rows).toEqual([
      { Fecha: "2026-11-04", Tipo: "Venta Contado", "Nº": "13840", "Estado DGI": "", Cliente: "Cliente Uno S.A.", Moneda: "$", Total: "6832", Saldo: "0" },
      { Fecha: "2026-10-10", Tipo: "Venta Contado", "Nº": "13791", "Estado DGI": "Aceptado", Cliente: "Cliente Uno S.A.", Moneda: "U$S", Total: "340.5", Saldo: "0" },
    ]);
  });

  it("skips a preamble in a CSV too", async () => {
    const file = new File(["Ventas del 01/04/2026 al 30/04/2026;\n\nFecha;Cliente;Total\n15/04/2026;Cliente Uno;1.220,00\n"], "v.csv", {
      type: "text/csv",
    });
    expect(await parseTabularFile(file)).toEqual({
      headers: ["Fecha", "Cliente", "Total"],
      rows: [{ Fecha: "15/04/2026", Cliente: "Cliente Uno", Total: "1.220,00" }],
    });
  });

  it("reads a CSV with ; and a BOM", async () => {
    const file = new File(["﻿Fecha;Cliente;Neto\n15/09/2026;Cliente Uno;1.234,50\n"], "ventas.csv", { type: "text/csv" });
    expect(await parseTabularFile(file)).toEqual({
      headers: ["Fecha", "Cliente", "Neto"],
      rows: [{ Fecha: "15/09/2026", Cliente: "Cliente Uno", Neto: "1.234,50" }],
    });
  });

  it("reads a CSV re-saved by Excel as Windows-1252 without mangling accents", async () => {
    // "Cliente;Neto\nConstrucción Ñandú;100\n" in Windows-1252 (ó = F3, Ñ = D1, ú = FA).
    const bytes = new Uint8Array([
      ...Buffer.from("Cliente;Neto\nConstrucci"), 0xf3, ...Buffer.from("n "), 0xd1, ...Buffer.from("and"), 0xfa,
      ...Buffer.from(";100\n"),
    ]);
    expect(await parseTabularFile(new File([bytes], "ventas.csv", { type: "text/csv" }))).toEqual({
      headers: ["Cliente", "Neto"],
      rows: [{ Cliente: "Construcción Ñandú", Neto: "100" }],
    });
    expect(await readTextFile(new File(["Ñandú"], "utf8.csv"))).toBe("Ñandú");
  });

  it("says what is wrong with an old .xls or an empty file", async () => {
    expect(await parseTabularFile(new File(["x"], "viejo.xls"))).toEqual({ error: expect.stringMatching(/\.xlsx o \.csv/) });
    expect(await parseTabularFile(new File(["Fecha;Cliente\n"], "vacio.csv"))).toEqual({
      error: "El archivo no tiene filas para importar.",
    });
  });
});
