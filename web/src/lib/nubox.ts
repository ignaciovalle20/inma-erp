import Papa from "papaparse";
import { parseCsvDate } from "@/lib/csvDate";

/**
 * Pure logic for the Nubox sales export (docs/cambios-flujo-v2.md 4.2):
 * parsing, validation, classification against what the ERP already has,
 * credit-note pairing and invoice -> job suggestions. No database, no
 * Next.js imports: the Server Actions feed it data and the tests (and a
 * check against the real export) run it as is.
 *
 * The database (import_nubox_documents_batch) re-decides create / update /
 * unchanged / review on its own -- this mirror only powers the preview.
 */

export type NuboxDocumentType = "invoice" | "credit_note";
export type NuboxPaymentStatus = "pagado" | "por_vencer" | "vencido" | "no_aplica";

export type NuboxDocument = {
  /** 1-based position of the row in the file, header excluded. */
  rowNumber: number;
  documentType: NuboxDocumentType;
  documentNumber: string;
  /** Normalized RUT, e.g. "76123456-7". */
  rut: string;
  clientName: string;
  documentDate: string;
  dueDate: string | null;
  /** Nubox "Monto neto" + "Monto exento": the net used for management. */
  netAmount: number;
  taxAmount: number;
  otherTaxes: number;
  totalAmount: number;
  paymentStatus: NuboxPaymentStatus;
  sendNumber: string | null;
  raw: Record<string, string>;
};

export type NuboxRowResult =
  | { rowNumber: number; raw: Record<string, string>; document: NuboxDocument; error: null; skipped: null }
  | { rowNumber: number; raw: Record<string, string>; document: null; error: string; skipped: null }
  | { rowNumber: number; raw: Record<string, string>; document: null; error: null; skipped: string };

const REQUIRED_HEADERS = [
  "Fecha",
  "Documento",
  "Folio",
  "Rut Cliente",
  "Cliente",
  "Monto neto",
  "Monto exento",
  "Monto IVA",
  "Monto impuestos",
  "Monto total",
  "Estado",
  "Fecha vencimiento",
  "Estado de cobro",
] as const;

const DOCUMENT_TYPES: Record<string, NuboxDocumentType> = {
  "FAC-EL": "invoice",
  "N/C-EL": "credit_note",
};

const PAYMENT_STATUSES: Record<string, NuboxPaymentStatus> = {
  BALANCED: "pagado",
  TO_EXPIRE: "por_vencer",
  EXPIRED: "vencido",
  NOT_APPLY: "no_aplica",
};

export function normalizeHeader(header: string): string {
  return header
    .replace(/^﻿/, "")
    .trim()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

/**
 * Nubox exports UTF-8 CSV with `;` separators and quoted values. Returns
 * the raw rows keyed by the file's own headers, or a user-facing error
 * (wrong separator, missing columns, malformed CSV) -- never throws.
 */
export function parseNuboxCsv(
  text: string,
): { rows: Record<string, string>[]; headers: string[]; error: null } | { rows: []; headers: []; error: string } {
  const parsed = Papa.parse<Record<string, string>>(text.replace(/^﻿/, ""), {
    header: true,
    delimiter: ";",
    skipEmptyLines: "greedy",
    transformHeader: (header) => header.replace(/^﻿/, "").trim(),
  });

  const headers = parsed.meta.fields ?? [];

  if (headers.length <= 1) {
    return {
      rows: [],
      headers: [],
      error:
        "El archivo no parece un export de Nubox: se esperaba un CSV separado por punto y coma (;).",
    };
  }

  const known = new Set(headers.map(normalizeHeader));
  const missing = REQUIRED_HEADERS.filter((header) => !known.has(normalizeHeader(header)));

  if (missing.length > 0) {
    return {
      rows: [],
      headers: [],
      error: `Faltan columnas del export de Nubox: ${missing.join(", ")}.`,
    };
  }

  const fatal = parsed.errors.find((error) => error.type === "Quotes");
  if (fatal) {
    return {
      rows: [],
      headers: [],
      error: `El CSV está mal formado (fila ${(fatal.row ?? 0) + 2}): ${fatal.message}.`,
    };
  }

  if (parsed.data.length === 0) {
    return { rows: [], headers: [], error: "El archivo no tiene filas." };
  }

  return { rows: parsed.data, headers, error: null };
}

function field(raw: Record<string, string>, name: string): string {
  const wanted = normalizeHeader(name);
  for (const key of Object.keys(raw)) {
    if (normalizeHeader(key) === wanted) return (raw[key] ?? "").trim();
  }
  return "";
}

/** "12.345.678-k" / "12345678k" -> "12345678-K"; null when it is not a RUT. */
export function normalizeRut(input: string | null | undefined): string | null {
  if (!input) return null;
  const compact = input.replace(/\s/g, "").toUpperCase();
  // Body (digits, optional dots) + at most one hyphen + check digit.
  const match = compact.match(/^([\d.]+)-?([\dK])$/);
  if (!match) return null;
  const body = match[1].replace(/\./g, "").replace(/^0+(?=\d)/, "");
  if (!/^\d{6,9}$/.test(body)) return null;
  return `${body}-${match[2]}`;
}

export function mapPaymentStatus(value: string): NuboxPaymentStatus | null {
  return PAYMENT_STATUSES[value.trim().toUpperCase()] ?? null;
}

function parseAmount(value: string, name: string, required: boolean): number | string {
  const trimmed = value.trim();
  if (trimmed === "") {
    return required ? `Falta ${name}` : 0;
  }
  // Nubox amounts are whole numbers with no thousands separator: anything
  // else (1.234, 12,5) is rejected rather than guessed at.
  if (!/^\d+$/.test(trimmed)) {
    return `${name} inválido ("${trimmed}"): se esperaba un entero sin separadores`;
  }
  return Number(trimmed);
}

export function validateNuboxRow(raw: Record<string, string>, rowNumber: number): NuboxRowResult {
  const fail = (error: string): NuboxRowResult => ({
    rowNumber,
    raw,
    document: null,
    error,
    skipped: null,
  });

  const estado = field(raw, "Estado");
  if (estado.toLowerCase() !== "emitido") {
    return {
      rowNumber,
      raw,
      document: null,
      error: null,
      skipped: `Estado "${estado || "vacío"}": solo se importan documentos emitidos`,
    };
  }

  const rawType = field(raw, "Documento");
  const documentType = DOCUMENT_TYPES[rawType.toUpperCase()];
  if (!documentType) {
    return fail(`Tipo de documento no soportado: "${rawType || "vacío"}"`);
  }

  const documentNumber = field(raw, "Folio");
  if (!documentNumber) return fail("Falta el folio");

  const rut = normalizeRut(field(raw, "Rut Cliente"));
  if (!rut) return fail(`RUT inválido: "${field(raw, "Rut Cliente")}"`);

  const clientName = field(raw, "Cliente");
  if (!clientName) return fail("Falta el nombre del cliente");

  const documentDate = parseCsvDate(field(raw, "Fecha"));
  if (!documentDate) return fail(`Fecha inválida: "${field(raw, "Fecha")}"`);

  const rawDue = field(raw, "Fecha vencimiento");
  const dueDate = rawDue ? parseCsvDate(rawDue) : null;
  if (rawDue && !dueDate) return fail(`Fecha de vencimiento inválida: "${rawDue}"`);

  const net = parseAmount(field(raw, "Monto neto"), "Monto neto", true);
  const exempt = parseAmount(field(raw, "Monto exento"), "Monto exento", false);
  const tax = parseAmount(field(raw, "Monto IVA"), "Monto IVA", false);
  const other = parseAmount(field(raw, "Monto impuestos"), "Monto impuestos", false);
  const total = parseAmount(field(raw, "Monto total"), "Monto total", true);

  for (const value of [net, exempt, tax, other, total]) {
    if (typeof value === "string") return fail(value);
  }

  const netAmount = (net as number) + (exempt as number);
  if (netAmount <= 0) return fail("El monto neto es cero");

  if (netAmount + (tax as number) + (other as number) !== (total as number)) {
    return fail(
      `El total (${total}) no cuadra con neto + exento + IVA + impuestos (${netAmount + (tax as number) + (other as number)})`,
    );
  }

  const paymentStatus = mapPaymentStatus(field(raw, "Estado de cobro"));
  if (!paymentStatus) {
    return fail(`Estado de cobro no reconocido: "${field(raw, "Estado de cobro") || "vacío"}"`);
  }

  return {
    rowNumber,
    raw,
    error: null,
    skipped: null,
    document: {
      rowNumber,
      documentType,
      documentNumber,
      rut,
      clientName,
      documentDate,
      dueDate,
      netAmount,
      taxAmount: tax as number,
      otherTaxes: other as number,
      totalAmount: total as number,
      paymentStatus,
      sendNumber: field(raw, "Nº de Envío") || null,
      raw,
    },
  };
}

/** Validates every row and flags folios repeated inside the same file. */
export function validateNuboxRows(rows: Record<string, string>[]): NuboxRowResult[] {
  const results = rows.map((raw, index) => validateNuboxRow(raw, index + 1));
  const seen = new Map<string, number>();

  return results.map((result) => {
    if (!result.document) return result;
    const key = documentKey(result.document.documentType, result.document.documentNumber);
    const first = seen.get(key);
    if (first !== undefined) {
      return {
        rowNumber: result.rowNumber,
        raw: result.raw,
        document: null,
        error: `Folio repetido en el archivo (también en la fila ${first})`,
        skipped: null,
      };
    }
    seen.set(key, result.rowNumber);
    return result;
  });
}

export function documentKey(type: NuboxDocumentType, number: string): string {
  return `${type}|${number.trim()}`;
}

// ---------------------------------------------------------------------
// Classification against what the ERP already has
// ---------------------------------------------------------------------

export type ExistingDocument = {
  id: string;
  documentType: string;
  documentNumber: string | null;
  clientId: string;
  netAmount: number;
  totalAmount: number;
  paymentStatus: string | null;
  dueDate: string | null;
  documentDate: string;
  voided: boolean;
  annulledByDocumentId: string | null;
  annulsDocumentId: string | null;
  projectId: string | null;
};

export type Classification =
  | { kind: "new" }
  | { kind: "update"; existing: ExistingDocument; change: string }
  | { kind: "unchanged"; existing: ExistingDocument }
  | { kind: "review"; existing: ExistingDocument; reason: string };

/**
 * `clientId` is the client the row resolves to by RUT, or null when that
 * RUT is not a client yet (it will be created -- so an already-stored
 * document can never belong to it, which makes it a "review").
 */
export function classifyDocument(
  document: NuboxDocument,
  clientId: string | null,
  existingByKey: Map<string, ExistingDocument>,
): Classification {
  const existing = existingByKey.get(documentKey(document.documentType, document.documentNumber));
  if (!existing) return { kind: "new" };

  if (existing.clientId !== clientId) {
    return { kind: "review", existing, reason: "Ya existe con otro cliente" };
  }
  if (
    Number(existing.netAmount) !== document.netAmount ||
    Number(existing.totalAmount) !== document.totalAmount
  ) {
    return { kind: "review", existing, reason: "Ya existe con montos distintos" };
  }

  const paymentChanged = existing.paymentStatus !== document.paymentStatus;
  const dueChanged = (existing.dueDate ?? null) !== document.dueDate;

  if (paymentChanged || dueChanged) {
    const parts: string[] = [];
    if (paymentChanged) {
      parts.push(`cobro ${existing.paymentStatus ?? "sin dato"} → ${document.paymentStatus}`);
    }
    if (dueChanged) {
      parts.push(`vencimiento ${existing.dueDate ?? "sin dato"} → ${document.dueDate ?? "sin dato"}`);
    }
    return { kind: "update", existing, change: parts.join(" · ") };
  }

  return { kind: "unchanged", existing };
}

export type ImportSummary = {
  new: number;
  updated: number;
  unchanged: number;
  review: number;
  errors: number;
  skipped: number;
};

export function summarize(
  results: NuboxRowResult[],
  classifications: Map<number, Classification>,
): ImportSummary {
  const summary: ImportSummary = { new: 0, updated: 0, unchanged: 0, review: 0, errors: 0, skipped: 0 };

  for (const result of results) {
    if (result.error) {
      summary.errors += 1;
    } else if (result.skipped) {
      summary.skipped += 1;
    } else {
      const kind = classifications.get(result.rowNumber)?.kind ?? "new";
      if (kind === "new") summary.new += 1;
      else if (kind === "update") summary.updated += 1;
      else if (kind === "unchanged") summary.unchanged += 1;
      else summary.review += 1;
    }
  }

  return summary;
}

/** "12 nuevas · 9 con cobro actualizado · 29 sin cambios · 0 a revisar" (+ errores/omitidas si hay). */
export function formatSummary(summary: ImportSummary): string {
  const parts = [
    `${summary.new} ${summary.new === 1 ? "nueva" : "nuevas"}`,
    `${summary.updated} con cobro actualizado`,
    `${summary.unchanged} sin cambios`,
    `${summary.review} a revisar`,
  ];
  if (summary.errors > 0) parts.push(`${summary.errors} con error`);
  if (summary.skipped > 0) parts.push(`${summary.skipped} omitidas`);
  return parts.join(" · ");
}

// ---------------------------------------------------------------------
// Credit notes (N/C) <-> invoices
// ---------------------------------------------------------------------

export type PairingCreditNote = {
  documentNumber: string;
  /** Client identity shared with invoices (normalized RUT). */
  clientKey: string;
  netAmount: number;
  documentDate: string;
};

export type PairingInvoice = {
  documentNumber: string;
  clientKey: string;
  netAmount: number;
  documentDate: string;
};

export type PairingSuggestion = {
  creditNoteNumber: string;
  /** Set when there was exactly one candidate (after removing taken ones). */
  autoPairedWith: string | null;
  /** Invoice folios still available for a manual choice (empty when auto-paired). */
  candidates: string[];
};

function compareByDateThenNumber(
  a: { documentDate: string; documentNumber: string },
  b: { documentDate: string; documentNumber: string },
): number {
  if (a.documentDate !== b.documentDate) return a.documentDate < b.documentDate ? -1 : 1;
  return a.documentNumber.localeCompare(b.documentNumber, undefined, { numeric: true });
}

/**
 * A credit note corrects the invoice of the same client, with the same net
 * and an earlier (or same-day) date that no other credit note has annulled.
 * One candidate pairs by itself; several are left for the user. Pairing is
 * resolved to a fixpoint, so the outcome does not depend on the order of
 * the notes: an invoice taken by an unambiguous note disappears from every
 * other note's list.
 *
 * `invoices` must already exclude annulled invoices; `creditNotes` must
 * already exclude notes that are paired.
 */
export function suggestCreditNotePairs(
  creditNotes: PairingCreditNote[],
  invoices: PairingInvoice[],
): PairingSuggestion[] {
  const taken = new Set<string>();
  const auto = new Map<string, string>();
  const notes = [...creditNotes].sort(compareByDateThenNumber);

  const candidatesFor = (note: PairingCreditNote) =>
    invoices
      .filter(
        (invoice) =>
          !taken.has(invoice.documentNumber) &&
          invoice.clientKey === note.clientKey &&
          invoice.netAmount === note.netAmount &&
          invoice.documentDate <= note.documentDate,
      )
      .sort(compareByDateThenNumber);

  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const note of notes) {
      if (auto.has(note.documentNumber)) continue;
      const candidates = candidatesFor(note);
      if (candidates.length === 1) {
        auto.set(note.documentNumber, candidates[0].documentNumber);
        taken.add(candidates[0].documentNumber);
        progressed = true;
      }
    }
  }

  return notes.map((note) => {
    const autoPairedWith = auto.get(note.documentNumber) ?? null;
    return {
      creditNoteNumber: note.documentNumber,
      autoPairedWith,
      candidates: autoPairedWith ? [] : candidatesFor(note).map((invoice) => invoice.documentNumber),
    };
  });
}

// ---------------------------------------------------------------------
// Invoice -> job (trabajo) by balance still to invoice
// ---------------------------------------------------------------------

export type JobBalance = {
  projectId: string;
  name: string;
  clientId: string;
  /** Quoted net amount (projects.budget); null = no amount, so no balance. */
  quotedAmount: number | null;
  /** Net of the non-annulled invoices already linked to the job. */
  invoicedAmount: number;
};

/** Balance still to invoice; null when the job has no quoted amount. */
export function jobBalance(job: JobBalance, extraInvoiced = 0): number | null {
  if (job.quotedAmount === null) return null;
  return job.quotedAmount - job.invoicedAmount - extraInvoiced;
}

export type LinkSuggestion = {
  documentNumber: string;
  /** Pre-marked job: the net equals the balance of exactly one job of the client. */
  suggestedProjectId: string | null;
};

/**
 * Only a net that equals the balance of exactly one job of the same client
 * is pre-marked (to confirm); everything else is chosen from a list. A
 * pre-marked invoice reduces that job's balance for the invoices that follow
 * (in date order), so a later invoice can match what is left.
 */
export function suggestProjectLinks(
  invoices: { documentNumber: string; clientId: string; netAmount: number; documentDate: string }[],
  jobs: JobBalance[],
): LinkSuggestion[] {
  const assigned = new Map<string, number>();

  return [...invoices].sort(compareByDateThenNumber).map((invoice) => {
    const matches = jobs.filter((job) => {
      if (job.clientId !== invoice.clientId) return false;
      const balance = jobBalance(job, assigned.get(job.projectId) ?? 0);
      return balance !== null && balance > 0 && balance === invoice.netAmount;
    });

    if (matches.length === 1) {
      const job = matches[0];
      assigned.set(job.projectId, (assigned.get(job.projectId) ?? 0) + invoice.netAmount);
      return { documentNumber: invoice.documentNumber, suggestedProjectId: job.projectId };
    }
    return { documentNumber: invoice.documentNumber, suggestedProjectId: null };
  });
}

/** Jobs of the client, those with balance left first (then by name). */
export function orderJobsForInvoice(jobs: JobBalance[], clientId: string, extraInvoiced: Map<string, number>): JobBalance[] {
  const ofClient = jobs.filter((job) => job.clientId === clientId);
  const hasBalance = (job: JobBalance) => {
    const balance = jobBalance(job, extraInvoiced.get(job.projectId) ?? 0);
    return balance !== null && balance > 0;
  };
  return [...ofClient].sort((a, b) => {
    const diff = Number(hasBalance(b)) - Number(hasBalance(a));
    return diff !== 0 ? diff : a.name.localeCompare(b.name);
  });
}
