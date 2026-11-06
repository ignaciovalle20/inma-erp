import Papa from "papaparse";

/**
 * Reads the file of a generic importer (sales or costs) into headers and
 * rows of text, whatever the format: CSV (any delimiter Papa detects) or
 * Excel .xlsx (first sheet). Headers come from the first row that looks like
 * column names, skipping a preamble the export may open with. The columns are
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

/**
 * A CSV's text. UTF-8 when the bytes are valid UTF-8; otherwise Windows-1252,
 * the encoding Excel uses when it re-saves a CSV on a Spanish Windows. Reading
 * those bytes as UTF-8 turned "Construcción Ñandú" into "Construcci�n �and�"
 * and created clients with that name (H13 of docs/auditoria-dev-2026-09-23.md).
 */
export async function readTextFile(file: File): Promise<string> {
  const bytes = await file.arrayBuffer();
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

async function readCsv(file: File): Promise<ParsedTable | { error: string }> {
  const text = (await readTextFile(file)).replace(/^﻿/, "");
  const parsed = Papa.parse<string[]>(text, { header: false, skipEmptyLines: "greedy" });

  if (parsed.errors.length > 0) {
    return { error: "No se pudo leer el archivo como CSV. Revisá su formato." };
  }

  return toTable(parsed.data.map((cells) => cells.map((cell) => (cell ?? "").trim())));
}

/** A cell that is a value, not a column name: a number, an amount or a date. */
function looksLikeData(cell: string): boolean {
  return (
    /^[-+]?[\d\s.,$]*\d[\d\s.,$]*$/.test(cell) ||
    /^\d{4}-\d{1,2}-\d{1,2}$/.test(cell) ||
    /^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}$/.test(cell)
  );
}

/**
 * The row that holds the column names. Exports often open with a few lines
 * that are not data (a date range, a filter, a blank line: "01/04/2026 al",
 * "Filter trimant") before the real headers; those are skipped. The header
 * row is the first one (of the first 20) that fills most of the table's width
 * with text only -- a row with a date or an amount is data or a preamble.
 * When none qualifies, the first row is the header, as before.
 */
export function findHeaderRow(values: string[][]): number {
  const filled = (cells: string[]) => cells.filter((cell) => cell !== "");
  const width = Math.max(0, ...values.map((cells) => filled(cells).length));
  const needed = Math.max(Math.min(2, width), Math.ceil(width * 0.6));
  for (let index = 0; index < Math.min(values.length, 20); index += 1) {
    const cells = filled(values[index]);
    if (cells.length >= needed && cells.every((cell) => !looksLikeData(cell))) return index;
  }
  return 0;
}

/** Headers (from the detected header row) and the rows below it, as text. */
export function toTable(allRows: string[][]): ParsedTable {
  const values = allRows.filter((cells) => cells.some((cell) => cell !== ""));
  const headerIndex = findHeaderRow(values);
  const headerRow = values[headerIndex];
  if (!headerRow) return { headers: [], rows: [] };
  const dataRows = values.slice(headerIndex + 1);
  const columnCount = Math.max(headerRow.length, ...dataRows.map((cells) => cells.length));

  // Empty or repeated headers still get a name the user can pick.
  const seen = new Map<string, number>();
  const headers = Array.from({ length: columnCount }, (_, index) => {
    const base = headerRow[index] || `Columna ${index + 1}`;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base} (${count})`;
  });

  const rows = dataRows.map((cells) =>
    Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ""])),
  );
  return { headers, rows };
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
      values.push(cells);
    });

    return toTable(values);
  } catch (error) {
    console.error(error);
    return { error: "No se pudo leer el archivo Excel. Revisá que sea un .xlsx válido." };
  }
}
