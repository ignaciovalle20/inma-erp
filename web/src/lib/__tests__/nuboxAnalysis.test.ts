/**
 * analyzeNuboxRows glues the pure Nubox logic to what the ERP already
 * has (clients by RUT, stored documents, invoices open to a credit note,
 * job balances). The reads are mocked; every client and folio is invented.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ExistingDocument, JobBalance } from "@/lib/nubox";

vi.mock("server-only", () => ({}));

type ClientRow = { id: string; name: string; tax_id: string | null };

const state: {
  clients: ClientRow[];
  existing: ExistingDocument[];
  pairable: { id: string; documentNumber: string; clientId: string; netAmount: number; documentDate: string }[];
  jobs: JobBalance[];
} = { clients: [], existing: [], pairable: [], jobs: [] };

vi.mock("@/lib/dal", () => ({
  getClients: async () => state.clients,
  getExistingDocumentsByNumber: async () => state.existing,
  getPairableInvoices: async () => state.pairable,
  getProjectBillingBalances: async () => state.jobs,
}));

import { analyzeNuboxRows } from "@/app/companies/[id]/sales/import/nubox/analysis";

function row(overrides: Record<string, string> = {}): Record<string, string> {
  return {
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
    "Nº de Envío": "1",
    Origen: "Manual Emision",
    "Fecha vencimiento": "10/09/2026",
    "Estado de cobro": "TO_EXPIRE",
    Cedido: "false",
    ...overrides,
  };
}

const noteRow = (overrides: Record<string, string> = {}) =>
  row({ Documento: "N/C-EL", Folio: "5001", Fecha: "07/09/2026", "Estado de cobro": "NOT_APPLY", ...overrides });

function stored(overrides: Partial<ExistingDocument>): ExistingDocument {
  return {
    id: "doc-1",
    documentType: "invoice",
    documentNumber: "1001",
    clientId: "client-1",
    netAmount: 86000,
    totalAmount: 102340,
    paymentStatus: "por_vencer",
    dueDate: "2026-09-10",
    documentDate: "2026-08-10",
    voided: false,
    annulledByDocumentId: null,
    annulsDocumentId: null,
    projectId: null,
    ...overrides,
  };
}

beforeEach(() => {
  state.clients = [{ id: "client-1", name: "Cliente Uno SpA", tax_id: "11.111.111-1" }];
  state.existing = [];
  state.pairable = [];
  state.jobs = [];
});

describe("analyzeNuboxRows", () => {
  it("matches a client by normalized RUT (stored with dots) and never by name", async () => {
    const analysis = await analyzeNuboxRows("c", [row({ Cliente: "Otro nombre completamente distinto" })]);
    expect(analysis.clientByRut.get("11111111-1")).toEqual({ id: "client-1", name: "Cliente Uno SpA" });
    expect(analysis.newClients).toEqual([]);
  });

  it("plans to create a client for an unknown RUT, with the name from the file", async () => {
    const analysis = await analyzeNuboxRows("c", [row({ "Rut Cliente": "22.222.222-2", Cliente: "Cliente Dos Ltda" })]);
    expect(analysis.newClients).toEqual([{ rut: "22222222-2", name: "Cliente Dos Ltda" }]);
    expect(analysis.clientByRut.get("22222222-2")).toBeNull();
  });

  it("turns a row into an error when two clients share the RUT", async () => {
    state.clients.push({ id: "client-9", name: "Cliente Uno Duplicado", tax_id: "11111111-1" });
    const analysis = await analyzeNuboxRows("c", [row()]);
    expect(analysis.results[0].error).toMatch(/2 clientes con el RUT 11111111-1/);
    expect(analysis.summary.errors).toBe(1);
  });

  it("reports what a re-import would do: unchanged, updated cobro, new", async () => {
    state.existing = [
      stored({ documentNumber: "1001" }),
      stored({ id: "doc-2", documentNumber: "1002", paymentStatus: "por_vencer" }),
    ];
    const analysis = await analyzeNuboxRows("c", [
      row({ Folio: "1001" }),
      row({ Folio: "1002", "Estado de cobro": "BALANCED" }),
      row({ Folio: "1003" }),
    ]);
    expect(analysis.summary).toMatchObject({ new: 1, updated: 1, unchanged: 1, review: 0 });
  });

  it("pairs a credit note with its only candidate, found in the file", async () => {
    const analysis = await analyzeNuboxRows("c", [row({ Folio: "1001" }), noteRow()]);
    expect(analysis.creditNotes[0]).toMatchObject({ documentNumber: "5001", state: "auto", autoPairedWith: "1001" });
  });

  it("finds the invoice among those already stored but absent from the file", async () => {
    state.pairable = [
      { id: "inv-old", documentNumber: "0900", clientId: "client-1", netAmount: 86000, documentDate: "2026-06-01" },
    ];
    const analysis = await analyzeNuboxRows("c", [noteRow()]);
    expect(analysis.creditNotes[0]).toMatchObject({ state: "auto", autoPairedWith: "0900" });
  });

  it("asks to choose when several invoices could be the one, and marks which are already stored", async () => {
    state.pairable = [
      { id: "inv-old", documentNumber: "0900", clientId: "client-1", netAmount: 86000, documentDate: "2026-06-01" },
    ];
    const analysis = await analyzeNuboxRows("c", [row({ Folio: "1001" }), noteRow()]);
    const note = analysis.creditNotes[0];
    expect(note.state).toBe("choose");
    expect(note.candidates).toEqual([
      { documentNumber: "0900", documentDate: "2026-06-01", inFile: false },
      { documentNumber: "1001", documentDate: "2026-08-10", inFile: true },
    ]);
  });

  it("does not offer an invoice that a stored credit note has already annulled", async () => {
    state.existing = [stored({ voided: true, annulledByDocumentId: "nc-x" })];
    const analysis = await analyzeNuboxRows("c", [row({ Folio: "1001" }), noteRow()]);
    expect(analysis.creditNotes[0].state).toBe("none");
  });

  it("does not re-pair a credit note that is already paired", async () => {
    state.existing = [
      stored({ documentType: "credit_note", documentNumber: "5001", annulsDocumentId: "doc-x", voided: true, paymentStatus: "no_aplica", dueDate: "2026-09-10", documentDate: "2026-09-07" }),
    ];
    const analysis = await analyzeNuboxRows("c", [noteRow()]);
    expect(analysis.creditNotes[0].state).toBe("paired");
  });

  it("offers job links only for new invoices of known clients, pre-marking an exact balance", async () => {
    state.jobs = [
      { projectId: "job-1", name: "Soporte", clientId: "client-1", quotedAmount: 86000, invoicedAmount: 0 },
      { projectId: "job-2", name: "Redes", clientId: "client-1", quotedAmount: 500000, invoicedAmount: 0 },
    ];
    state.existing = [stored({ documentNumber: "1002", id: "doc-2" })];

    const analysis = await analyzeNuboxRows("c", [
      row({ Folio: "1001" }), // new, known client
      row({ Folio: "1002" }), // already stored -> not linkable here
      row({ Folio: "1003", "Rut Cliente": "22.222.222-2", Cliente: "Cliente Dos" }), // unknown client
    ]);

    expect(analysis.invoiceLinks.map((link) => link.documentNumber)).toEqual(["1001"]);
    expect(analysis.invoiceLinks[0].suggestedProjectId).toBe("job-1");
  });

  it("does not offer a job link for an invoice a credit note is about to annul", async () => {
    state.jobs = [{ projectId: "job-1", name: "Soporte", clientId: "client-1", quotedAmount: 86000, invoicedAmount: 0 }];
    const analysis = await analyzeNuboxRows("c", [row({ Folio: "1001" }), noteRow()]);
    expect(analysis.invoiceLinks).toEqual([]);
  });
});
