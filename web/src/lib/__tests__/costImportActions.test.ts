/**
 * The costs import Server Action (commitImport) with the Nubox purchases
 * export: exempt invoices and credit notes reach import_cost_rows_batch with
 * Neto + Exento as the amount, positive amounts plus their document type,
 * and a row that doesn't add up stays out of the call with its reason.
 * Suppliers and rows are invented.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type RpcCall = { name: string; args: Record<string, unknown> };
const rpcCalls: RpcCall[] = [];
const inserted: { table: string; rows: Record<string, unknown>[] }[] = [];

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc: (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      if (name === "create_cost_import_batch") {
        return Promise.resolve({ data: { id: "batch-1" }, error: null });
      }
      if (name === "import_cost_rows_batch") {
        const sent = (args.p_rows as { row_number: number }[]).map((row) => ({
          row_number: row.row_number,
          status: "imported",
          error_message: null,
          cost_document_id: `doc-${row.row_number}`,
        }));
        return Promise.resolve({ data: sent, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
    from: (table: string) => ({
      insert: (rows: Record<string, unknown>[]) => {
        inserted.push({ table, rows });
        const result = Promise.resolve({ error: null }) as Promise<{ error: null }> & { select: () => unknown };
        result.select = () => Promise.resolve({ data: [], error: null });
        return result;
      },
    }),
  }),
}));

vi.mock("@/lib/costAllocationSuggestionsLoader", () => ({
  suggestCostAllocations: async () => ({ confirmed: 0, suggested: 0, error: null }),
}));

vi.mock("@/lib/technicianDocumentSuggestions", () => ({
  suggestTechnicianDocuments: async () => ({ created: 0, error: null }),
}));

vi.mock("@/lib/dal", () => ({
  getCompanyForEdit: async () => ({
    company: { country: "CL", currency: "CLP", name: "Empresa de prueba" },
    role: "admin",
  }),
  getSuppliers: async () => [{ id: "supplier-1", name: "Proveedor Uno SpA", active: true }],
}));

import { commitImport, type ColumnMapping } from "@/app/companies/[id]/costs/import/actions";

const mapping: ColumnMapping = {
  date: "Fecha emisión",
  supplier: "Proveedor",
  amount: "Neto",
  currency: null,
  tax: "IVA",
  taxId: "RUT proveedor",
  exempt: "Exento",
  otherTaxes: "Otros impuestos",
  total: "Total",
  documentType: "Tipo documento",
  documentNumber: "Nº documento",
  status: "Estado",
};

const row = (overrides: Record<string, string>) => ({
  "Fecha emisión": "01/10/2026",
  "Tipo documento": "FAC-EL",
  "Nº documento": "1",
  "RUT proveedor": "11111111-1",
  Proveedor: "Proveedor Uno SpA",
  Neto: "0",
  Exento: "0",
  IVA: "0",
  "Otros impuestos": "0",
  Total: "0",
  Estado: "Aceptado",
  ...overrides,
});

const sentRows = () =>
  (rpcCalls.find((call) => call.name === "import_cost_rows_batch")?.args.p_rows as Record<string, unknown>[]) ?? [];

beforeEach(() => {
  rpcCalls.length = 0;
  inserted.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("commitImport (costs) with the Nubox purchases export", () => {
  it("sends exempt documents with Neto + Exento and the credit note's type", async () => {
    const result = await commitImport("company-1", "compras.csv", [
      row({ "Tipo documento": "FAC-EE", "Nº documento": "10", Exento: "105263", Total: "105263" }),
      row({ "Tipo documento": "N/C-EL", "Nº documento": "11", Exento: "35319", Total: "35319" }),
      row({ "Nº documento": "12", Neto: "403695", IVA: "76702", Total: "480397" }),
    ], mapping);

    expect(result.error).toBeNull();
    expect(
      sentRows().map((sent) => ({
        amount: sent.amount,
        exempt_amount: sent.exempt_amount,
        tax_amount: sent.tax_amount,
        other_taxes: sent.other_taxes,
        document_type: sent.document_type,
        source_document_type: sent.source_document_type,
        document_number: sent.document_number,
      })),
    ).toEqual([
      { amount: 105263, exempt_amount: 105263, tax_amount: 0, other_taxes: 0, document_type: "invoice", source_document_type: "FAC-EE", document_number: "10" },
      { amount: 35319, exempt_amount: 35319, tax_amount: 0, other_taxes: 0, document_type: "credit_note", source_document_type: "N/C-EL", document_number: "11" },
      { amount: 403695, exempt_amount: 0, tax_amount: 76702, other_taxes: 0, document_type: "invoice", source_document_type: "FAC-EL", document_number: "12" },
    ]);
    expect(sentRows().some((sent) => "rejection" in sent)).toBe(false);
  });

  it("keeps a row that doesn't add up out of the database call, with a clear reason", async () => {
    const result = await commitImport("company-1", "compras.csv", [
      row({ Neto: "1000", IVA: "190", Total: "1190" }),
      row({ "Nº documento": "2", Neto: "1000", IVA: "190", Total: "1500" }),
      row({ "Nº documento": "3", Neto: "0", Exento: "0", Total: "0" }),
    ], mapping);

    expect(sentRows().map((sent) => sent.row_number)).toEqual([1]);
    const saved = inserted.find((entry) => entry.table === "cost_import_rows");
    expect(saved?.rows.map((saved) => [saved.row_number, saved.status, saved.error_message])).toEqual([
      [2, "error", 'Total "1500" no cuadra con Neto + Exento + IVA + Otros impuestos (1190, diferencia 310)'],
      [3, "error", 'Neto y Exento en 0 (Neto "0", Exento "0")'],
    ]);
    if (result.error !== null) throw new Error(result.error);
    expect(result.rowResults.map((result) => result.status)).toEqual(["imported", "error", "error"]);
  });
});
