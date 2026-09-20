/**
 * Nubox sales export (docs/cambios-flujo-v2.md 4.2). Every RUT, name and
 * folio below is invented -- no real client data lives in this repo.
 */
import { describe, it, expect } from "vitest";
import {
  parseNuboxCsv,
  normalizeRut,
  validateNuboxRow,
  validateNuboxRows,
  classifyDocument,
  summarize,
  formatSummary,
  normalizeClientName,
  suggestAdoptions,
  type LegacyDocument,
  documentKey,
  suggestCreditNotePairs,
  suggestProjectLinks,
  orderJobsForInvoice,
  jobBalance,
  type ExistingDocument,
  type NuboxDocument,
  type Classification,
  type JobBalance,
} from "@/lib/nubox";

const HEADERS = [
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
  "Nº de Envío",
  "Origen",
  "Fecha vencimiento",
  "Estado de cobro",
  "Cedido",
];

function row(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    Fecha: "10/08/2026",
    Documento: "FAC-EL",
    Folio: "1001",
    "Rut Cliente": "11111111-1",
    Cliente: "Cliente Uno SpA",
    "Monto neto": "100000",
    "Monto exento": "0",
    "Monto IVA": "19000",
    "Monto impuestos": "0",
    "Monto total": "119000",
    Estado: "Emitido",
    "Nº de Envío": "555",
    Origen: "Manual Emision",
    "Fecha vencimiento": "10/09/2026",
    "Estado de cobro": "TO_EXPIRE",
    Cedido: "false",
    ...overrides,
  };
}

function toCsv(rows: Record<string, string>[], withBom = false): string {
  const lines = [HEADERS.map((h) => `"${h}"`).join(";")];
  for (const r of rows) lines.push(HEADERS.map((h) => `"${r[h] ?? ""}"`).join(";"));
  return (withBom ? "﻿" : "") + lines.join("\r\n") + "\r\n";
}

function doc(overrides: Record<string, string> = {}): NuboxDocument {
  const result = validateNuboxRow(row(overrides), 1);
  if (!result.document) throw new Error(`fixture row invalid: ${result.error ?? result.skipped}`);
  return result.document;
}

function existingFrom(document: NuboxDocument, clientId: string, extra: Partial<ExistingDocument> = {}): ExistingDocument {
  return {
    id: `id-${document.documentType}-${document.documentNumber}`,
    documentType: document.documentType,
    documentNumber: document.documentNumber,
    clientId,
    netAmount: document.netAmount,
    totalAmount: document.totalAmount,
    paymentStatus: document.paymentStatus,
    dueDate: document.dueDate,
    documentDate: document.documentDate,
    voided: false,
    annulledByDocumentId: null,
    annulsDocumentId: null,
    projectId: null,
    ...extra,
  };
}

describe("parseNuboxCsv", () => {
  it("parses a `;`-separated, quoted export (with BOM)", () => {
    const parsed = parseNuboxCsv(toCsv([row(), row({ Folio: "1002" })], true));
    expect(parsed.error).toBeNull();
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[1].Folio).toBe("1002");
    expect(parsed.rows[0]["Rut Cliente"]).toBe("11111111-1");
  });

  it("rejects a comma-separated file with a clear message", () => {
    const parsed = parseNuboxCsv("Fecha,Documento,Folio\n01/01/2026,FAC-EL,1\n");
    expect(parsed.error).toMatch(/punto y coma/);
  });

  it("lists the missing columns", () => {
    const parsed = parseNuboxCsv('"Fecha";"Documento";"Folio"\n"01/01/2026";"FAC-EL";"1"\n');
    expect(parsed.error).toMatch(/Faltan columnas/);
    expect(parsed.error).toMatch(/Rut Cliente/);
  });

  it("rejects a file with only a header", () => {
    const parsed = parseNuboxCsv(toCsv([]));
    expect(parsed.error).toMatch(/no tiene filas/);
  });
});

describe("normalizeRut", () => {
  it.each([
    ["11.111.111-1", "11111111-1"],
    ["11111111-1", "11111111-1"],
    ["111111111", "11111111-1"],
    ["9.999.999-k", "9999999-K"],
    ["09999999K", "9999999-K"],
    [" 1.234.567-8 ", "1234567-8"],
  ])("%s -> %s", (input, expected) => {
    expect(normalizeRut(input)).toBe(expected);
  });

  it.each(["", "abc", "12-3-4", "1.2", null, undefined])("rejects %s", (input) => {
    expect(normalizeRut(input as string | null | undefined)).toBeNull();
  });
});

describe("validateNuboxRow", () => {
  it("maps a normal invoice", () => {
    const result = validateNuboxRow(row(), 7);
    expect(result.error).toBeNull();
    expect(result.document).toMatchObject({
      rowNumber: 7,
      documentType: "invoice",
      documentNumber: "1001",
      rut: "11111111-1",
      documentDate: "2026-08-10",
      dueDate: "2026-09-10",
      netAmount: 100000,
      taxAmount: 19000,
      totalAmount: 119000,
      paymentStatus: "por_vencer",
      sendNumber: "555",
    });
  });

  it("adds exempt to the net used for management", () => {
    const d = doc({ "Monto neto": "60000", "Monto exento": "40000" });
    expect(d.netAmount).toBe(100000);
  });

  it("keeps other taxes apart from the net", () => {
    const d = doc({ "Monto impuestos": "500", "Monto total": "119500" });
    expect(d.netAmount).toBe(100000);
    expect(d.otherTaxes).toBe(500);
  });

  it("maps the four cobro states", () => {
    expect(doc({ "Estado de cobro": "BALANCED" }).paymentStatus).toBe("pagado");
    expect(doc({ "Estado de cobro": "TO_EXPIRE" }).paymentStatus).toBe("por_vencer");
    expect(doc({ "Estado de cobro": "EXPIRED" }).paymentStatus).toBe("vencido");
    expect(doc({ Documento: "N/C-EL", "Estado de cobro": "NOT_APPLY" }).paymentStatus).toBe("no_aplica");
  });

  it("maps N/C-EL to a credit note", () => {
    expect(doc({ Documento: "N/C-EL", "Estado de cobro": "NOT_APPLY" }).documentType).toBe("credit_note");
  });

  it("imports a factura exenta (FAC-EE) as an invoice, its exento counting as net", () => {
    const result = validateNuboxRow(
      row({ Documento: "FAC-EE", "Monto neto": "0", "Monto exento": "1300000", "Monto IVA": "0", "Monto total": "1300000" }),
      1,
    );
    expect(result.error).toBeNull();
    expect(result.document).toMatchObject({ documentType: "invoice", netAmount: 1300000, totalAmount: 1300000 });
  });

  it("leaves boletas out with an explanation instead of an error (they have no unique folio)", () => {
    for (const type of ["BOL-EL", "BOL-VO"]) {
      const result = validateNuboxRow(row({ Documento: type, Folio: "0" }), 1);
      expect(result.error).toBeNull();
      expect(result.document).toBeNull();
      expect(result.skipped).toContain(`Boleta (${type}): las boletas no se importan`);
    }
  });

  it("skips documents that are not Emitido, without an error", () => {
    const result = validateNuboxRow(row({ Estado: "Anulado" }), 1);
    expect(result.skipped).toMatch(/solo se importan documentos emitidos/);
    expect(result.error).toBeNull();
  });

  it.each([
    [{ Documento: "XYZ-99" }, /Tipo de documento no soportado: "XYZ-99"/],
    [{ Folio: "" }, /Falta el folio/],
    [{ "Rut Cliente": "sin rut" }, /RUT inválido/],
    [{ Cliente: "" }, /nombre del cliente/],
    [{ Fecha: "31/02/2026" }, /Fecha inválida/],
    [{ "Fecha vencimiento": "mañana" }, /vencimiento inválida/],
    [{ "Monto neto": "1.234" }, /Monto neto inválido/],
    [{ "Monto neto": "12,5" }, /Monto neto inválido/],
    [{ "Monto neto": "" }, /Falta Monto neto/],
    [{ "Monto neto": "0", "Monto IVA": "0", "Monto total": "0" }, /neto es cero/],
    [{ "Monto total": "118000" }, /no cuadra/],
    [{ "Estado de cobro": "PAID" }, /Estado de cobro no reconocido/],
  ])("reports an error for %j", (overrides, message) => {
    const result = validateNuboxRow(row(overrides), 1);
    expect(result.document).toBeNull();
    expect(result.error).toMatch(message);
  });

  it("flags a folio repeated inside the file, naming the first row", () => {
    const results = validateNuboxRows([row(), row({ Cliente: "Otro" })]);
    expect(results[0].error).toBeNull();
    expect(results[1].error).toMatch(/Folio repetido en el archivo.*fila 1/);
  });

  it("does not treat the same folio as repeated across document types", () => {
    const results = validateNuboxRows([
      row(),
      row({ Documento: "N/C-EL", "Estado de cobro": "NOT_APPLY" }),
    ]);
    expect(results.every((r) => r.error === null)).toBe(true);
  });
});

describe("classifyDocument (upsert on re-import)", () => {
  const clientId = "client-1";
  const byKey = (existing: ExistingDocument[]) =>
    new Map(existing.map((e) => [documentKey(e.documentType as "invoice", e.documentNumber ?? ""), e]));

  it("is new when the folio is not stored", () => {
    expect(classifyDocument(doc(), clientId, byKey([])).kind).toBe("new");
  });

  it("is unchanged when nothing differs", () => {
    const d = doc();
    expect(classifyDocument(d, clientId, byKey([existingFrom(d, clientId)])).kind).toBe("unchanged");
  });

  it("updates when the cobro changed", () => {
    const stored = existingFrom(doc(), clientId);
    const c = classifyDocument(doc({ "Estado de cobro": "BALANCED" }), clientId, byKey([stored]));
    expect(c.kind).toBe("update");
    expect(c.kind === "update" && c.change).toMatch(/por_vencer → pagado/);
  });

  it("updates when only the due date changed", () => {
    const stored = existingFrom(doc(), clientId);
    const c = classifyDocument(doc({ "Fecha vencimiento": "10/10/2026" }), clientId, byKey([stored]));
    expect(c.kind).toBe("update");
  });

  it("updates a legacy row that has no cobro data yet", () => {
    const stored = existingFrom(doc(), clientId, { paymentStatus: null, dueDate: null });
    expect(classifyDocument(doc(), clientId, byKey([stored])).kind).toBe("update");
  });

  it("asks for review (and touches nothing) when the amounts differ", () => {
    const stored = existingFrom(doc(), clientId, { netAmount: 90000, totalAmount: 107100 });
    const c = classifyDocument(doc(), clientId, byKey([stored]));
    expect(c.kind).toBe("review");
  });

  it("asks for review when the stored client is different", () => {
    const stored = existingFrom(doc(), "other-client");
    expect(classifyDocument(doc(), clientId, byKey([stored])).kind).toBe("review");
    expect(classifyDocument(doc(), null, byKey([stored])).kind).toBe("review");
  });

  it("does not confuse an invoice and a credit note with the same folio", () => {
    const nc = doc({ Documento: "N/C-EL", Folio: "1001", "Estado de cobro": "NOT_APPLY" });
    const storedInvoice = existingFrom(doc(), clientId);
    expect(classifyDocument(nc, clientId, byKey([storedInvoice])).kind).toBe("new");
  });
});

describe("re-importing the same file", () => {
  it("creates 3 documents the first time and 0 the second, with the same total", () => {
    const rows = [
      row({ Folio: "1001" }),
      row({ Folio: "1002", "Estado de cobro": "BALANCED" }),
      row({ Folio: "5001", Documento: "N/C-EL", "Estado de cobro": "NOT_APPLY" }),
    ];
    const first = validateNuboxRows(rows);
    const stored = new Map<string, ExistingDocument>();

    const classify = () => {
      const classes = new Map<number, Classification>();
      for (const r of first) {
        if (r.document) {
          classes.set(r.rowNumber, classifyDocument(r.document, "client-1", stored));
        }
      }
      return classes;
    };

    const firstRun = classify();
    expect(summarize(first, firstRun).new).toBe(3);
    for (const r of first) {
      if (r.document) {
        stored.set(documentKey(r.document.documentType, r.document.documentNumber), existingFrom(r.document, "client-1"));
      }
    }

    const secondRun = classify();
    const summary = summarize(first, secondRun);
    expect(summary).toMatchObject({ new: 0, updated: 0, unchanged: 3, review: 0 });
    expect(stored.size).toBe(3);
  });

  it("formats the summary like the spec", () => {
    expect(formatSummary({ new: 12, adopted: 0, updated: 9, unchanged: 29, review: 0, errors: 0, skipped: 0 })).toBe(
      "12 nuevas · 9 con cobro actualizado · 29 sin cambios · 0 a revisar",
    );
    expect(formatSummary({ new: 1, adopted: 0, updated: 0, unchanged: 0, review: 0, errors: 2, skipped: 1 })).toBe(
      "1 nueva · 0 con cobro actualizado · 0 sin cambios · 0 a revisar · 2 con error · 1 omitidas",
    );
  });
});

describe("suggestCreditNotePairs", () => {
  const inv = (n: string, date: string, net = 86000, clientKey = "11111111-1") => ({
    documentNumber: n,
    clientKey,
    netAmount: net,
    documentDate: date,
  });
  const nc = (n: string, date: string, net = 86000, clientKey = "11111111-1") => ({
    documentNumber: n,
    clientKey,
    netAmount: net,
    documentDate: date,
  });

  it("pairs by itself when there is exactly one candidate", () => {
    const [s] = suggestCreditNotePairs([nc("900", "2026-07-28", 4000000)], [inv("800", "2026-07-24", 4000000), inv("801", "2026-07-24", 100)]);
    expect(s).toEqual({ creditNoteNumber: "900", autoPairedWith: "800", candidates: [] });
  });

  it("offers a list when there are several candidates", () => {
    const [s] = suggestCreditNotePairs(
      [nc("900", "2026-09-07")],
      [inv("801", "2026-08-01"), inv("802", "2026-08-02"), inv("803", "2026-09-02")],
    );
    expect(s.autoPairedWith).toBeNull();
    expect(s.candidates).toEqual(["801", "802", "803"]);
  });

  it("leaves a note with no candidate unpaired", () => {
    const [s] = suggestCreditNotePairs([nc("900", "2026-09-07")], [inv("801", "2026-08-01", 5)]);
    expect(s).toEqual({ creditNoteNumber: "900", autoPairedWith: null, candidates: [] });
  });

  it("ignores invoices of other clients and later invoices", () => {
    const [s] = suggestCreditNotePairs(
      [nc("900", "2026-09-07")],
      [inv("801", "2026-08-01", 86000, "22222222-2"), inv("802", "2026-09-08")],
    );
    expect(s.candidates).toEqual([]);
  });

  it("accepts an invoice dated the same day as the credit note", () => {
    const [s] = suggestCreditNotePairs([nc("900", "2026-09-07")], [inv("801", "2026-09-07")]);
    expect(s.autoPairedWith).toBe("801");
  });

  it("does not reuse an invoice already taken by another note", () => {
    const result = suggestCreditNotePairs(
      [nc("900", "2026-09-07"), nc("901", "2026-09-07")],
      [inv("801", "2026-08-01"), inv("802", "2026-08-02")],
    );
    // Two notes, two candidates each: nothing is unambiguous.
    expect(result.map((s) => s.autoPairedWith)).toEqual([null, null]);
    expect(result[0].candidates).toEqual(["801", "802"]);
    expect(result[1].candidates).toEqual(["801", "802"]);
  });

  it("resolves to a fixpoint: an unambiguous note frees the ambiguous one", () => {
    // 900 (07/09) only sees 801 (802 is dated after it) -> pairs by itself.
    // 901 (08/09) sees both, but once 900 takes 801 it is left with 802 -> pairs too.
    const result = suggestCreditNotePairs(
      [nc("901", "2026-09-08", 86000), nc("900", "2026-09-07", 86000)],
      [inv("801", "2026-08-01", 86000), inv("802", "2026-09-08", 86000)],
    );
    expect(result.find((s) => s.creditNoteNumber === "900")?.autoPairedWith).toBe("801");
    expect(result.find((s) => s.creditNoteNumber === "901")?.autoPairedWith).toBe("802");
  });
});

describe("job balance and invoice -> job suggestion", () => {
  const job = (projectId: string, quotedAmount: number | null, invoicedAmount = 0, clientId = "client-1"): JobBalance => ({
    projectId,
    name: projectId,
    clientId,
    quotedAmount,
    invoicedAmount,
  });
  const invoice = (documentNumber: string, netAmount: number, documentDate = "2026-08-10", clientId = "client-1") => ({
    documentNumber,
    clientId,
    netAmount,
    documentDate,
  });

  it("computes the balance as quoted - invoiced", () => {
    expect(jobBalance(job("a", 1000, 400))).toBe(600);
    expect(jobBalance(job("a", null))).toBeNull();
    expect(jobBalance(job("a", 1000, 400), 100)).toBe(500);
  });

  it("pre-marks the only job whose balance equals the net", () => {
    const [s] = suggestProjectLinks([invoice("1", 500)], [job("a", 500), job("b", 900)]);
    expect(s.suggestedProjectId).toBe("a");
  });

  it("does not pre-mark when two jobs have the same balance", () => {
    const [s] = suggestProjectLinks([invoice("1", 500)], [job("a", 500), job("b", 500)]);
    expect(s.suggestedProjectId).toBeNull();
  });

  it("does not pre-mark a net that differs from every balance", () => {
    const [s] = suggestProjectLinks([invoice("1", 400)], [job("a", 500)]);
    expect(s.suggestedProjectId).toBeNull();
  });

  it("ignores jobs without quoted amount, without balance, or of another client", () => {
    const [s] = suggestProjectLinks(
      [invoice("1", 500)],
      [job("a", null), job("b", 500, 500), job("c", 500, 0, "client-2")],
    );
    expect(s.suggestedProjectId).toBeNull();
  });

  it("does not pre-mark installments smaller than the job's balance", () => {
    const result = suggestProjectLinks(
      [invoice("2", 500, "2026-09-02"), invoice("1", 500, "2026-08-01")],
      [job("a", 1000)],
    );
    // Only an exact match to the balance is pre-marked; a half installment is chosen from the list.
    expect(result.map((s) => s.suggestedProjectId)).toEqual([null, null]);
  });

  it("uses the balance left after an earlier pre-marked invoice", () => {
    const result = suggestProjectLinks(
      [invoice("1", 400, "2026-08-01"), invoice("2", 600, "2026-09-01")],
      [job("a", 400), job("b", 1000, 400)],
    );
    // 400 matches job a exactly; 600 then matches job b's balance (1000 - 400).
    expect(result.map((s) => s.suggestedProjectId)).toEqual(["a", "b"]);
  });

  it("lets a monthly job resolve on its own: last month's job has no balance", () => {
    const [s] = suggestProjectLinks(
      [invoice("9", 49900, "2026-09-05")],
      [job("aug", 49900, 49900), job("sep", 49900, 0)],
    );
    expect(s.suggestedProjectId).toBe("sep");
  });

  it("orders the client's jobs with balance first", () => {
    const jobs = [job("z-full", 100, 100), job("a-open", 100, 0), job("m-open", 100, 30), job("other", 100, 0, "client-2")];
    const ordered = orderJobsForInvoice(jobs, "client-1", new Map()).map((j) => j.projectId);
    expect(ordered).toEqual(["a-open", "m-open", "z-full"]);
  });

  it("takes into account what the preview already assigned", () => {
    const jobs = [job("a", 100, 0), job("b", 100, 0)];
    const ordered = orderJobsForInvoice(jobs, "client-1", new Map([["a", 100]])).map((j) => j.projectId);
    expect(ordered).toEqual(["b", "a"]);
  });
});

describe("reconciling with sales loaded before Nubox", () => {
  const legacy = (overrides: Partial<LegacyDocument>): LegacyDocument => ({
    id: "old-1",
    clientId: "client-1",
    documentDate: "2026-08-10",
    netAmount: 86000,
    totalAmount: 86000,
    documentType: "manual",
    createdAt: "2026-09-14T20:00:00Z",
    ...overrides,
  });
  const candidate = (overrides: Partial<Parameters<typeof suggestAdoptions>[0][number]>) => ({
    rowNumber: 1,
    documentNumber: "1001",
    clientId: "client-1",
    documentDate: "2026-08-10",
    netAmount: 86000,
    ...overrides,
  });

  it("normalizes client names: accents, case, punctuation and spaces", () => {
    expect(normalizeClientName("  Inmobiliaria  Ñandú S.P.A. ")).toBe("inmobiliaria nandu s p a");
    expect(normalizeClientName("INMOBILIARIA ÑANDU S.P.A")).toBe("inmobiliaria nandu s p a");
    expect(normalizeClientName(null)).toBe("");
  });

  it("adopts a stored sale with the same client, date and net", () => {
    const { adopted, leftover } = suggestAdoptions([candidate({})], [legacy({})]);
    expect(adopted.get(1)?.id).toBe("old-1");
    expect(leftover).toEqual([]);
  });

  it("does not adopt when the client, the date or the net differ", () => {
    const { adopted, leftover } = suggestAdoptions(
      [candidate({})],
      [
        legacy({ id: "a", clientId: "client-2" }),
        legacy({ id: "b", documentDate: "2026-08-11" }),
        legacy({ id: "c", netAmount: 86001 }),
      ],
    );
    expect(adopted.size).toBe(0);
    expect(leftover.map((doc) => doc.id).sort()).toEqual(["a", "b", "c"]);
  });

  it("pairs identical sales one by one (oldest stored first) and leaves the extra one over", () => {
    const stored = [
      legacy({ id: "newer", createdAt: "2026-09-15T00:00:00Z" }),
      legacy({ id: "older", createdAt: "2026-09-14T00:00:00Z" }),
    ];
    const { adopted, leftover } = suggestAdoptions([candidate({ rowNumber: 1, documentNumber: "1001" })], stored);
    expect(adopted.get(1)?.id).toBe("older");
    expect(leftover.map((doc) => doc.id)).toEqual(["newer"]);
  });

  it("gives two identical invoices two different stored sales, in folio order", () => {
    const stored = [
      legacy({ id: "s1", createdAt: "2026-09-14T00:00:00Z" }),
      legacy({ id: "s2", createdAt: "2026-09-14T00:00:01Z" }),
    ];
    const { adopted } = suggestAdoptions(
      [candidate({ rowNumber: 9, documentNumber: "2681" }), candidate({ rowNumber: 8, documentNumber: "2666" })],
      stored,
    );
    expect(adopted.get(8)?.id).toBe("s1");
    expect(adopted.get(9)?.id).toBe("s2");
  });

  it("counts adopted rows apart in the summary and says so", () => {
    const first = validateNuboxRows([
      {
        Fecha: "10/08/2026",
        Documento: "FAC-EL",
        Folio: "1001",
        "Rut Cliente": "11111111-1",
        Cliente: "Cliente Uno SpA",
        "Monto neto": "86000",
        "Monto exento": "0",
        "Monto IVA": "16340",
        "Monto impuestos": "0",
        "Monto total": "102340",
        Estado: "Emitido",
        "Fecha vencimiento": "10/09/2026",
        "Estado de cobro": "TO_EXPIRE",
      },
    ]);
    const summary = summarize(first, new Map([[1, { kind: "adopt", legacy: legacy({}) } as Classification]]));
    expect(summary).toMatchObject({ new: 0, adopted: 1 });
    expect(formatSummary(summary)).toBe(
      "0 nuevas · 1 vinculadas a ventas ya cargadas · 0 con cobro actualizado · 0 sin cambios · 0 a revisar",
    );
  });
});
