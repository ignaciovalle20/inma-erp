/**
 * The generic sales importer (Uruguay and anyone without Nubox) used to strip
 * every comma from an amount: "1234,5" reached the database as 12345
 * (docs/plan-sistema-v3.md, B4). Amounts now go through one parser, and a row
 * whose amount or tax cannot be read is kept in the batch with the real reason
 * instead of being sent on (or, for the tax, silently read as 0).
 * All clients and rows below are invented.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type RpcCall = { name: string; args: Record<string, unknown> };
const rpcCalls: RpcCall[] = [];
const inserted: { table: string; rows: Record<string, unknown>[] }[] = [];

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc: (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      if (name === "create_import_batch") {
        const promise = Promise.resolve({ data: { id: "batch-1" }, error: null }) as Promise<unknown> & {
          select: () => { single: () => Promise<unknown> };
        };
        (promise as unknown as { select: unknown }).select = () => ({
          single: () => Promise.resolve({ data: { id: "batch-1" }, error: null }),
        });
        return promise;
      }
      if (name === "import_sales_rows_batch") {
        // Answers one row per row it was sent, like the real function.
        const sent = (args.p_rows as { row_number: number }[]).map((row) => ({
          row_number: row.row_number,
          status: "imported",
          error_message: null,
        }));
        return Promise.resolve({ data: sent, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
    from: (table: string) => ({
      insert: (rows: Record<string, unknown>[]) => {
        inserted.push({ table, rows });
        return Promise.resolve({ error: null });
      },
      upsert: () => Promise.resolve({ error: null }),
    }),
  }),
}));

vi.mock("@/lib/dal", () => ({
  getCompanyForEdit: async () => ({
    company: { country: "CL", currency: "CLP", name: "Empresa de prueba" },
    role: "admin",
  }),
  getClients: async () => [{ id: "client-1", name: "Cliente Uno SpA", active: true }],
  getClientAliases: async () => [],
}));

import { commitImport } from "@/app/companies/[id]/sales/import/actions";

const mapping = { date: "Fecha", client: "Cliente", amount: "Monto", currency: null, tax: "IVA", taxId: null };

const line = (overrides: Record<string, string>) => ({
  Fecha: "10/08/2026",
  Cliente: "Cliente Uno SpA",
  Monto: "86000",
  IVA: "",
  ...overrides,
});

const sentRows = () =>
  (rpcCalls.find((call) => call.name === "import_sales_rows_batch")?.args.p_rows as Record<string, unknown>[]) ?? [];

beforeEach(() => {
  rpcCalls.length = 0;
  inserted.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("commitImport amounts", () => {
  it("sends the amount and tax the way they read, not with the commas stripped", async () => {
    const result = await commitImport(
      "company-1",
      "f.csv",
      [line({ Monto: "1234,5", IVA: "234,5" }), line({ Monto: "1.234.567", IVA: "234.555" }), line({ Monto: "86000", IVA: "" })],
      mapping,
    );

    expect(result.error).toBeNull();
    const rows = sentRows();
    expect(rows.map((row) => [row.amount, row.tax_amount])).toEqual([
      [1234.5, 234.5],
      [1234567, 234555],
      [86000, 0],
    ]);
    expect(rows.some((row) => "rejection" in row)).toBe(false);
  });

  it("keeps a row with an unreadable amount out of the database call, with its reason", async () => {
    const result = await commitImport(
      "company-1",
      "f.csv",
      [line({ Monto: "86000" }), line({ Monto: "1,234" }), line({ Monto: "doce" })],
      mapping,
    );

    expect(sentRows().map((row) => row.row_number)).toEqual([1]);
    const saved = inserted.find((entry) => entry.table === "import_rows");
    expect(saved?.rows).toHaveLength(2);
    expect(saved?.rows[0]).toMatchObject({ import_batch_id: "batch-1", row_number: 2, status: "error" });
    expect(saved?.rows[0].error_message).toMatch(/Importe inválido "1,234".*ambiguo/);
    expect(saved?.rows[1].error_message).toMatch(/Importe inválido "doce"/);

    if (result.error !== null) throw new Error(result.error);
    expect(result.rowResults.map((row) => [row.rowNumber, row.status])).toEqual([
      [1, "imported"],
      [2, "error"],
      [3, "error"],
    ]);
    expect(result.rowResults[1].message).toMatch(/ambiguo/);
  });

  it("does not read an unreadable tax as zero: the row is rejected", async () => {
    const result = await commitImport("company-1", "f.csv", [line({ IVA: "diecinueve" })], mapping);

    expect(sentRows()).toHaveLength(0);
    const saved = inserted.find((entry) => entry.table === "import_rows");
    expect(saved?.rows[0].error_message).toMatch(/^IVA inválido "diecinueve"/);
    if (result.error !== null) throw new Error(result.error);
    expect(result.rowResults[0]).toMatchObject({ rowNumber: 1, status: "error" });
  });
});
