/**
 * commitNuboxImport: the browser only contributes the user's choices, so
 * they are re-validated on the server, and every failure comes back as a
 * real message (never silent). All data below is invented.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NuboxAnalysis } from "@/app/companies/[id]/sales/import/nubox/analysis";
import type { NuboxDocument } from "@/lib/nubox";

type RpcResult = { data?: unknown; error: { message: string } | null };

const state: {
  rpc: Record<string, RpcResult>;
  analysis: NuboxAnalysis;
  country: string;
  insertError: { message: string } | null;
} = {
  rpc: {},
  analysis: undefined as unknown as NuboxAnalysis,
  country: "CL",
  insertError: null,
};
const rpcCalls: { name: string; args: Record<string, unknown> }[] = [];
const inserted: { table: string; rows: Record<string, unknown>[] }[] = [];
const revalidatePath = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc: (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      const result = state.rpc[name] ?? { data: null, error: null };
      const promise = Promise.resolve(result) as Promise<RpcResult> & {
        select: () => { single: () => Promise<RpcResult> };
      };
      promise.select = () => ({ single: () => Promise.resolve(result) });
      return promise;
    },
    from: (table: string) => ({
      insert: (rows: Record<string, unknown>[]) => {
        inserted.push({ table, rows });
        const result =
          table === "clients"
            ? { data: rows.map((row, index) => ({ id: `new-${index}`, tax_id: row.tax_id })), error: null }
            : { error: state.insertError };
        const promise = Promise.resolve(result) as Promise<typeof result> & { select: () => Promise<typeof result> };
        promise.select = () => Promise.resolve(result);
        return promise;
      },
    }),
  }),
}));

vi.mock("@/lib/dal", () => ({
  getCompanyForEdit: async () => ({
    company: { country: state.country, currency: "CLP", name: "Empresa de prueba" },
    role: "admin",
  }),
}));

vi.mock("next/cache", () => ({ revalidatePath: (path: string) => revalidatePath(path) }));

vi.mock("@/app/companies/[id]/sales/import/nubox/analysis", () => ({
  analyzeNuboxRows: async () => state.analysis,
}));

import { commitNuboxImport } from "@/app/companies/[id]/sales/import/nubox/actions";

function document(overrides: Partial<NuboxDocument>): NuboxDocument {
  return {
    rowNumber: 1,
    documentType: "invoice",
    documentNumber: "1001",
    rut: "11111111-1",
    clientName: "Cliente Uno SpA",
    documentDate: "2026-08-10",
    dueDate: "2026-09-10",
    netAmount: 86000,
    taxAmount: 16340,
    otherTaxes: 0,
    totalAmount: 102340,
    paymentStatus: "por_vencer",
    sendNumber: null,
    raw: {},
    ...overrides,
  };
}

function buildAnalysis(): NuboxAnalysis {
  const invoiceA = document({ rowNumber: 1, documentNumber: "1001", raw: { Folio: "1001" } });
  const invoiceB = document({ rowNumber: 2, documentNumber: "1002", raw: { Folio: "1002" } });
  const noteA = document({
    rowNumber: 3,
    documentType: "credit_note",
    documentNumber: "5001",
    paymentStatus: "no_aplica",
    raw: { Folio: "5001" },
  });
  const noteB = document({
    rowNumber: 4,
    documentType: "credit_note",
    documentNumber: "5002",
    paymentStatus: "no_aplica",
    raw: { Folio: "5002" },
  });
  const candidates = [
    { documentNumber: "1001", documentDate: "2026-08-10", inFile: true },
    { documentNumber: "1002", documentDate: "2026-08-10", inFile: true },
  ];

  return {
    results: [
      { rowNumber: 1, raw: invoiceA.raw, document: invoiceA, error: null, skipped: null },
      { rowNumber: 2, raw: invoiceB.raw, document: invoiceB, error: null, skipped: null },
      { rowNumber: 3, raw: noteA.raw, document: noteA, error: null, skipped: null },
      { rowNumber: 4, raw: noteB.raw, document: noteB, error: null, skipped: null },
      { rowNumber: 5, raw: { Folio: "9" }, document: null, error: "Monto neto inválido", skipped: null },
    ],
    classifications: new Map(),
    summary: { new: 4, updated: 0, unchanged: 0, review: 0, errors: 1, skipped: 0 },
    clientByRut: new Map([["11111111-1", { id: "client-1", name: "Cliente Uno SpA" }]]),
    newClients: [],
    creditNotes: [
      { documentNumber: "5001", clientName: "Cliente Uno SpA", documentDate: "2026-09-07", netAmount: 86000, state: "choose", autoPairedWith: null, candidates },
      { documentNumber: "5002", clientName: "Cliente Uno SpA", documentDate: "2026-09-07", netAmount: 86000, state: "choose", autoPairedWith: null, candidates },
    ],
    invoiceLinks: [
      { documentNumber: "1001", rowNumber: 1, clientId: "client-1", clientName: "Cliente Uno SpA", documentDate: "2026-08-10", netAmount: 86000, suggestedProjectId: "job-1" },
      { documentNumber: "1002", rowNumber: 2, clientId: "client-1", clientName: "Cliente Uno SpA", documentDate: "2026-08-10", netAmount: 86000, suggestedProjectId: null },
    ],
    jobs: [
      { projectId: "job-1", name: "Soporte", clientId: "client-1", quotedAmount: 86000, invoicedAmount: 0 },
      { projectId: "job-x", name: "Otro cliente", clientId: "client-2", quotedAmount: 86000, invoicedAmount: 0 },
    ],
  };
}

const RAW_ROWS = [{ Folio: "1001" }];

function batchRpcRows(): Record<string, unknown>[] {
  const call = rpcCalls.find((entry) => entry.name === "import_nubox_documents_batch");
  return (call?.args.p_rows as Record<string, unknown>[]) ?? [];
}

beforeEach(() => {
  rpcCalls.length = 0;
  inserted.length = 0;
  revalidatePath.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
  state.country = "CL";
  state.insertError = null;
  state.analysis = buildAnalysis();
  state.rpc = {
    create_import_batch: { data: { id: "batch-1" }, error: null },
    import_nubox_documents_batch: {
      data: [
        { row_number: 1, status: "imported", error_message: null },
        { row_number: 2, status: "imported", error_message: null },
        { row_number: 3, status: "imported", error_message: null },
        { row_number: 4, status: "imported", error_message: null },
      ],
      error: null,
    },
    update_import_batch_counts: { data: {}, error: null },
  };
});

describe("commitNuboxImport", () => {
  it("only imports for Chile", async () => {
    state.country = "UY";
    const result = await commitNuboxImport("company-1", "f.csv", RAW_ROWS, { pairs: {}, links: {} });
    expect(result.error).toMatch(/solo está disponible para empresas de Chile/);
    expect(rpcCalls).toHaveLength(0);
  });

  it("rejects pairing a credit note with an invoice that is not one of its candidates", async () => {
    const result = await commitNuboxImport("company-1", "f.csv", RAW_ROWS, {
      pairs: { "5001": "9999" },
      links: {},
    });
    expect(result.error).toMatch(/La N\/C 5001 no puede emparejarse con la factura 9999/);
    expect(rpcCalls).toHaveLength(0);
  });

  it("rejects the same invoice chosen for two credit notes", async () => {
    const result = await commitNuboxImport("company-1", "f.csv", RAW_ROWS, {
      pairs: { "5001": "1001", "5002": "1001" },
      links: {},
    });
    expect(result.error).toMatch(/1001 está elegida para más de una nota de crédito/);
  });

  it("rejects a job that belongs to another client", async () => {
    const result = await commitNuboxImport("company-1", "f.csv", RAW_ROWS, {
      pairs: {},
      links: { "1002": "job-x" },
    });
    expect(result.error).toMatch(/1002 no existe o es de otro cliente/);
  });

  it("uses the pre-marked job by default and sends the user's pairing to the database", async () => {
    const result = await commitNuboxImport("company-1", "f.csv", RAW_ROWS, {
      pairs: { "5001": "1002" },
      links: {},
    });

    expect(result.error).toBeNull();
    const rows = batchRpcRows();
    const byFolio = (folio: string) => rows.find((row) => row.document_number === folio);
    expect(byFolio("1001")?.project_id).toBe("job-1");
    expect(byFolio("1002")?.project_id).toBeNull();
    expect(byFolio("5001")?.pair_with_document_number).toBe("1002");
    expect(byFolio("5002")?.pair_with_document_number).toBeNull();
    expect(byFolio("1001")?.client_id).toBe("client-1");
    expect(byFolio("1001")?.currency).toBe("CLP");
  });

  it("does not link an invoice that is being annulled by a credit note", async () => {
    await commitNuboxImport("company-1", "f.csv", RAW_ROWS, {
      pairs: { "5001": "1001" },
      links: {},
    });
    const row = batchRpcRows().find((entry) => entry.document_number === "1001");
    expect(row?.project_id).toBeNull();
  });

  it("returns the real database message when the batch fails", async () => {
    state.rpc.import_nubox_documents_batch = { data: null, error: { message: "permission denied for table sales_documents" } };
    const result = await commitNuboxImport("company-1", "f.csv", RAW_ROWS, { pairs: {}, links: {} });
    expect(result.error).toMatch(/permission denied for table sales_documents/);
    expect(result.error).toMatch(/no se guardó ninguna fila/);
  });

  it("returns the real message when the batch cannot be created", async () => {
    state.rpc.create_import_batch = { data: null, error: { message: "Import is only available for Chile-based companies" } };
    const result = await commitNuboxImport("company-1", "f.csv", RAW_ROWS, { pairs: {}, links: {} });
    expect(result.error).toMatch(/Import is only available/);
  });

  it("keeps rows rejected by the app in the batch and in the result, with their reason", async () => {
    const result = await commitNuboxImport("company-1", "f.csv", RAW_ROWS, { pairs: {}, links: {} });

    expect(result.error).toBeNull();
    if (result.error !== null) return;

    const stored = inserted.find((entry) => entry.table === "import_rows");
    expect(stored?.rows).toEqual([
      expect.objectContaining({ row_number: 5, status: "error", error_message: "Monto neto inválido" }),
    ]);
    expect(result.counts.errors).toBe(1);
    expect(result.rowResults.find((row) => row.rowNumber === 5)).toMatchObject({
      status: "error",
      message: "Monto neto inválido",
      folio: "9",
    });
    expect(rpcCalls.find((call) => call.name === "create_import_batch")?.args.p_total_rows).toBe(5);
  });

  it("warns (instead of hiding it) when the error rows could not be saved", async () => {
    state.insertError = { message: "row-level security violation" };
    const result = await commitNuboxImport("company-1", "f.csv", RAW_ROWS, { pairs: {}, links: {} });
    expect(result.error).toBeNull();
    if (result.error !== null) return;
    expect(result.warnings.join(" ")).toMatch(/row-level security violation/);
  });

  it("counts a pairing the database refused as not paired", async () => {
    state.rpc.import_nubox_documents_batch = {
      data: [
        { row_number: 1, status: "imported", error_message: null },
        { row_number: 2, status: "imported", error_message: null },
        { row_number: 3, status: "imported", error_message: "No se pudo emparejar con la factura 1002: The invoice is already annulled" },
        { row_number: 4, status: "imported", error_message: null },
      ],
      error: null,
    };
    const result = await commitNuboxImport("company-1", "f.csv", RAW_ROWS, {
      pairs: { "5001": "1002" },
      links: {},
    });
    expect(result.error).toBeNull();
    if (result.error !== null) return;
    expect(result.pairedCreditNotes).toBe(0);
    expect(result.rowResults.find((row) => row.rowNumber === 3)?.message).toMatch(/already annulled/);
  });

  it("revalidates the sales screens after a successful import", async () => {
    await commitNuboxImport("company-1", "f.csv", RAW_ROWS, { pairs: {}, links: {} });
    expect(revalidatePath).toHaveBeenCalledWith("/companies/company-1/sales");
    expect(revalidatePath).toHaveBeenCalledWith("/companies/company-1/sales/pending");
  });
});
