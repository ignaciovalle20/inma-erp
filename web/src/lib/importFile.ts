import Papa from "papaparse";

/**
 * Reads the file of a generic importer (sales or costs) into headers and
 * rows of text, whatever the format: CSV (any delimiter Papa detects) or
 * Excel .xlsx (first sheet, first non-empty row as headers). The columns are
 * never assumed: the user maps them in the next step. Every value comes back
 * as text, in the shapes the importers already parse (dates as YYYY-MM-DD,
 * numbers with a decimal point).
 */
export type ParsedTable = { headers: string[]; rows: Record<string, string>[] };

const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export async function parseTabularFile(file: File): Promise<ParsedTable | { error: string }> {
  const name = file.name.toLowerCase();

  if (name.endsWith(".xls")) {
    return { error: "El formato .xls (Excel 97-2003) no se puede leer: guardalo como .xlsx o .csv." };
  }

  const table = name.endsWith(".xlsx") || file.type === XLSX_TYPE ? await readXlsx(file) : await readCsv(file);
  if ("error" in table) return table;

  if (table.headers.length === 0 || table.rows.length === 0) {
    return { error: "El archivo no tiene filas para importar." };
  }
  return table;
}

async function readCsv(file: File): Promise<ParsedTable | { error: string }> {
  const text = await file.text();
  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (header) => header.replace(/^﻿/, "").trim(),
  });

  if (parsed.errors.length > 0) {
    return { error: "No se pudo leer el archivo como CSV. Revisá su formato." };
  }

  return { headers: parsed.meta.fields ?? [], rows: parsed.data };
}

function isoDate(date: Date): string {
  // Excel dates carry no time zone: exceljs hands them back as UTC midnight.
  return date.toISOString().slice(0, 10);
}

/** A cell value as the text the importers parse. */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "" : isoDate(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "";
    // Cents at most, written with a decimal point ("1234.5"), which the
    // amount parser reads as a decimal (never as a thousands separator).
    return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
  }
  if (typeof value === "string") return value.trim();
  if (typeof value === "boolean") return value ? "sí" : "no";
  if (typeof value === "object") {
    const cell = value as { result?: unknown; richText?: { text: string }[]; text?: unknown; error?: unknown };
    if ("result" in cell) return cellText(cell.result);
    if (Array.isArray(cell.richText)) return cell.richText.map((part) => part.text).join("").trim();
    if ("text" in cell) return cellText(cell.text);
    if ("error" in cell) return "";
  }
  return String(value).trim();
}

async function readXlsx(file: File): Promise<ParsedTable | { error: string }> {
  try {
    const { default: ExcelJS } = await import("exceljs");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load((await file.arrayBuffer()) as Parameters<typeof workbook.xlsx.load>[0]);
    const sheet = workbook.worksheets[0];
    if (!sheet) return { error: "El Excel no tiene hojas." };

    const values: string[][] = [];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const cells: string[] = [];
      for (let column = 1; column <= sheet.columnCount; column += 1) {
        cells.push(cellText(row.getCell(column).value));
      }
      if (cells.some((cell) => cell !== "")) values.push(cells);
    });

    const [headerRow, ...dataRows] = values;
    if (!headerRow) return { headers: [], rows: [] };

    // Empty or repeated headers still get a name the user can pick.
    const seen = new Map<string, number>();
    const headers = headerRow.map((raw, index) => {
      const base = raw || `Columna ${index + 1}`;
      const count = (seen.get(base) ?? 0) + 1;
      seen.set(base, count);
      return count === 1 ? base : `${base} (${count})`;
    });

    const rows = dataRows.map((cells) =>
      Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ""])),
    );
    return { headers, rows };
  } catch (error) {
    console.error(error);
    return { error: "No se pudo leer el archivo Excel. Revisá que sea un .xlsx válido." };
  }
}
