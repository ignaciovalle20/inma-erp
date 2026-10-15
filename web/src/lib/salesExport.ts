import { formatDisplayDate, paymentStatusLabel } from "@/lib/paymentStatus";
import { currencyDecimals } from "@/lib/currencies";

/**
 * CSV of the sales list, opened directly by Excel in Spanish: `;` as the
 * separator, UTF-8 with BOM (so accents survive), dd/mm/aaaa dates and a
 * decimal comma. Pure, so it can be tested without a database.
 */

export type SalesExportRow = {
  documentDate: string;
  documentType: string;
  documentNumber: string | null;
  clientName: string | null;
  areaName: string | null;
  projectName: string | null;
  netAmount: number;
  cost: number | null;
  profit: number | null;
  marginPct: number | null;
  paymentStatus: string | null;
  dueDate: string | null;
  annulledBy: string | null;
  voided: boolean;
  /** The document's own currency (its net is in it); CLP when missing. */
  currency?: string;
  paidAt?: string | null;
};

const TYPE_LABEL: Record<string, string> = {
  invoice: "Factura",
  credit_note: "Nota de crédito",
  receipt: "Recibo",
  manual: "Venta manual",
};

const HEADERS = [
  "Fecha",
  "Documento",
  "Folio",
  "Cliente",
  "Área",
  "Trabajo",
  "Neto",
  "Gasto",
  "Ganancia",
  "Margen %",
  "Estado de pago",
  "Vencimiento",
  "Anulada",
  "Moneda",
  "Fecha de pago",
];

function cell(value: string): string {
  // A cell that starts with = + - @ would be run as a formula by Excel;
  // client and job names come from outside, so neutralize them.
  // A plain (possibly negative) number is left alone.
  const isNumber = /^-?\d+([.,]\d+)?$/.test(value);
  const safe = /^[=+\-@]/.test(value) && !isNumber ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

function amount(value: number | null): string {
  return value === null ? "" : String(Math.round(value));
}

/** The net in its own currency: whole pesos for CLP, cents (decimal comma) otherwise. */
function net(value: number, currency: string): string {
  const decimals = currencyDecimals(currency);
  return decimals === 0 ? String(Math.round(value)) : value.toFixed(decimals).replace(".", ",");
}

function percent(value: number | null): string {
  return value === null ? "" : value.toFixed(1).replace(".", ",");
}

export function buildSalesCsv(rows: SalesExportRow[]): string {
  const lines = [HEADERS.map(cell).join(";")];

  for (const row of rows) {
    const sign = row.documentType === "credit_note" ? -1 : 1;
    lines.push(
      [
        formatDisplayDate(row.documentDate),
        TYPE_LABEL[row.documentType] ?? row.documentType,
        row.documentNumber ?? "",
        row.clientName ?? "",
        row.areaName ?? "",
        row.projectName ?? "",
        net(sign * row.netAmount, row.currency ?? "CLP"),
        amount(row.cost),
        amount(row.profit),
        percent(row.marginPct),
        row.paymentStatus ? paymentStatusLabel(row.paymentStatus) : "",
        row.dueDate ? formatDisplayDate(row.dueDate) : "",
        row.voided ? (row.annulledBy ? `Sí (N/C o factura ${row.annulledBy})` : "Sí") : "",
        row.currency ?? "CLP",
        row.paidAt ? formatDisplayDate(row.paidAt) : "",
      ]
        .map(cell)
        .join(";"),
    );
  }

  return `﻿${lines.join("\r\n")}\r\n`;
}
