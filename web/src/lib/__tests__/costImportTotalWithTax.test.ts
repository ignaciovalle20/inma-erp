/**
 * The costs import can map a column as the total with IVA included instead of
 * the net (e.g. the Uruguayan purchases export: Fecha, Tipo "Factura", Número,
 * Emisor, R.U.T., Moneda, Total): net and IVA are split with the company's
 * rate, and stored as a Neto + IVA file would be. Suppliers and rows are
 * invented.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { purchaseRowCells, resolvePurchaseRow, type PurchaseColumnMapping } from "@/lib/purchaseImport";

const cellsMapping: PurchaseColumnMapping = {
  amount: "Total",
  exempt: null,
  tax: null,
  otherTaxes: null,
  total: null,
  documentType: "Tipo",
  documentNumber: "Número",
  status: null,
};

const resolve = (
  row: Record<string, string>,
  opts: { vatRate?: number | null; currency?: string; mapping?: Partial<PurchaseColumnMapping> } = {},
) =>
  resolvePurchaseRow(purchaseRowCells(row, { ...cellsMapping, ...opts.mapping }), {
    basis: "total_with_tax",
    vatRate: opts.vatRate === undefined ? 0.22 : opts.vatRate,
    currency: opts.currency ?? "USD",
  });

describe("resolvePurchaseRow with a total with IVA included", () => {
  it("Uruguay: 1.220 -> net 1.000, IVA 220 (22 %)", () => {
    expect(resolve({ Total: "1.220,00", Tipo: "Factura", Número: "1030331" })).toEqual({
      error: null,
      amounts: {
        documentType: "invoice",
        sourceDocumentType: "FAC-EL",
        documentNumber: "1030331",
        netAmount: 1000,
        exemptAmount: 0,
        taxAmount: 220,
        otherTaxes: 0,
        totalAmount: 1220,
        withholdingAmount: null,
        taxComputed: true,
      },
    });
  });

  it("Chile: 1.190 CLP -> net 1.000, IVA 190 (19 %)", () => {
    expect(resolve({ Total: "1.190", Tipo: "FAC-EL", Número: "1" }, { vatRate: 0.19, currency: "CLP" }).amounts).toMatchObject({
      netAmount: 1000,
      taxAmount: 190,
      totalAmount: 1190,
    });
  });

  it("rounds to the currency so that net + IVA is exactly the total", () => {
    const amounts = resolve({ Total: "300", Tipo: "Factura", Número: "1" }).amounts!;
    expect(amounts).toMatchObject({ netAmount: 245.9, taxAmount: 54.1, totalAmount: 300 });
  });

  it("an exempt row, or one with IVA 0, has net equal to the total", () => {
    for (const IVA of ["Exento", "0"]) {
      expect(resolve({ Total: "1220", Tipo: "Factura", Número: "1", IVA }, { mapping: { tax: "IVA" } }).amounts).toMatchObject({
        netAmount: 1220,
        taxAmount: 0,
        totalAmount: 1220,
        taxComputed: false,
      });
    }
  });

  it("takes the exempt part and other taxes out before splitting", () => {
    const amounts = resolve(
      { Total: "1320", Tipo: "Factura", Número: "1", Exento: "100" },
      { mapping: { exempt: "Exento" } },
    ).amounts!;
    expect(amounts).toMatchObject({ netAmount: 1100, exemptAmount: 100, taxAmount: 220, totalAmount: 1320 });
  });

  it("reads plain-word types: Factura, Nota de crédito", () => {
    const note = resolve({ Total: "-1220", Tipo: "Nota de crédito", Número: "9" }).amounts!;
    expect(note).toMatchObject({ documentType: "credit_note", sourceDocumentType: "N/C-EL", netAmount: 1000, taxAmount: 220 });
  });

  it("rejects what can't be split, with the reason", () => {
    expect(resolve({ Total: "1220", Tipo: "Factura", Número: "1" }, { vatRate: null }).error).toMatch(/tasa de IVA/);
    expect(resolve({ Total: "1220", Tipo: "BOL-HE", Número: "1" }).error).toMatch(/boleta de honorarios.*Neto/);
    expect(resolve({ Total: "1220", Tipo: "Factura", Número: "1", Total2: "1220" }, { mapping: { total: "Total2" } }).error).toMatch(
      /no mapees también/,
    );
    expect(resolve({ Total: "1,234", Tipo: "Factura", Número: "1" }).error).toMatch(/ambiguo/);
  });

  it("the net basis is unchanged: Neto as read, no taxComputed", () => {
    const result = resolvePurchaseRow(purchaseRowCells({ Neto: "1000", IVA: "190" }, { ...cellsMapping, amount: "Neto", tax: "IVA", documentType: null, documentNumber: null }));
    expect(result.amounts).toEqual({
      documentType: "invoice",
      sourceDocumentType: null,
      documentNumber: null,
      netAmount: 1000,
      exemptAmount: 0,
      taxAmount: 190,
      otherTaxes: 0,
      totalAmount: 1190,
      withholdingAmount: null,
    });
  });
});

// --- commitImport: what reaches the database ---------------------------

const company = vi.hoisted(() => ({ current: { country: "UY", currency: "UYU", name: "Empresa UY" } }));
type RpcCall = { name: string; args: Record<string, unknown> };
const rpcCalls: RpcCall[] = [];

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc: (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      if (name === "create_cost_import_batch") return Promise.resolve({ data: { id: "batch-1" }, error: null });
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
        const result = Promise.resolve({ error: null }) as Promise<{ error: null }> & { select: () => unknown };
        result.select = () =>
          Promise.resolve({
            data: table === "suppliers" ? rows.map((created, index) => ({ id: `created-${index + 1}`, ...created })) : [],
            error: null,
          });
        return result;
      },
      update: () => ({ eq: () => ({ is: () => Promise.resolve({ error: null }) }) }),
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
  getCompanyForEdit: async () => ({ company: company.current, role: "admin" }),
  getSuppliers: async () => [],
}));

import { commitImport, type ColumnMapping } from "@/app/companies/[id]/costs/import/actions";

const mapping: ColumnMapping = {
  date: "Fecha",
  supplier: "Emisor",
  amount: "Total",
  amountBasis: "total_with_tax",
  currency: "Moneda",
  tax: null,
  taxId: "R.U.T.",
  exempt: null,
  otherTaxes: null,
  total: null,
  documentType: "Tipo",
  documentNumber: "Número",
  status: null,
};

const line = (overrides: Record<string, string>) => ({
  Fecha: "2026-11-03",
  Tipo: "Factura",
  Número: "1030331",
  Emisor: "Proveedor Uno S.A.",
  "R.U.T.": "210000000011",
  Moneda: "USD",
  Total: "300",
  ...overrides,
});

const sentRows = () =>
  (rpcCalls.find((call) => call.name === "import_cost_rows_batch")?.args.p_rows as Record<string, unknown>[]) ?? [];

beforeEach(() => {
  rpcCalls.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("commitImport (costs) with a total with IVA included", () => {
  it("Uruguay: sends the net and IVA split at 22 %, in the row's currency", async () => {
    company.current = { country: "UY", currency: "UYU", name: "Empresa UY" };
    const result = await commitImport("company-1", "compras.xlsx", [
      line({ Total: "1220", Moneda: "USD" }),
      line({ Número: "1030332", Total: "1.220,00", Moneda: "$" }),
    ], mapping);

    expect(result.error).toBeNull();
    expect(sentRows().map((row) => [row.amount, row.tax_amount, row.currency, row.source_document_type, row.document_number])).toEqual([
      [1000, 220, "USD", "FAC-EL", "1030331"],
      [1000, 220, "UYU", "FAC-EL", "1030332"],
    ]);
  });

  it("Chile: splits at 19 %", async () => {
    company.current = { country: "CL", currency: "CLP", name: "Empresa CL" };
    const result = await commitImport("company-1", "compras.xlsx", [line({ Total: "1190", Moneda: "CLP" })], mapping);

    expect(result.error).toBeNull();
    expect(sentRows().map((row) => [row.amount, row.tax_amount, row.currency])).toEqual([[1000, 190, "CLP"]]);
  });

  it("rejects mapping the total with IVA and a Total column at the same time", async () => {
    const result = await commitImport("company-1", "compras.xlsx", [line({})], { ...mapping, total: "Total" });
    expect(result.error).toMatch(/no mapees también la columna Total/);
    expect(sentRows()).toHaveLength(0);
  });
});
