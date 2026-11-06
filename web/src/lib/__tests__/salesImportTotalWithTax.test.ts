/**
 * The generic sales importer can map a column as the total with IVA included,
 * instead of the net: net and IVA are then split with the company's rate
 * (Uruguay 22 %, Chile 19 %), and stored exactly as a net + IVA file would be.
 * All clients and rows below are invented.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { companyConfig } from "@/lib/companyConfig";
import { parseCurrencyCell, parseSaleTaxCell, resolveRowCurrency, resolveSaleAmounts } from "@/lib/genericImport";

const UY = companyConfig({ country: "UY", currency: "UYU" });
const CL = companyConfig({ country: "CL", currency: "CLP" });

const total = (amountCell: string, opts: { taxCell?: string | null; currency?: string; vatRate?: number | null } = {}) =>
  resolveSaleAmounts({
    basis: "total_with_tax",
    amountCell,
    taxCell: opts.taxCell ?? null,
    vatRate: opts.vatRate === undefined ? UY.vatRate : opts.vatRate,
    currency: opts.currency ?? "UYU",
  });

describe("resolveSaleAmounts with a total with IVA included", () => {
  it("splits 1.220 UYU with Uruguay's 22 %: net 1.000, IVA 220", () => {
    expect(total("1220", { vatRate: UY.vatRate })).toEqual({
      kind: "ok",
      value: { net: 1000, tax: 220, total: 1220, taxComputed: true },
    });
  });

  it("splits 1.190 CLP with Chile's 19 %: net 1.000, IVA 190", () => {
    expect(total("1190", { vatRate: CL.vatRate, currency: "CLP" })).toEqual({
      kind: "ok",
      value: { net: 1000, tax: 190, total: 1190, taxComputed: true },
    });
  });

  it("reads the comma-decimal, dot-thousands format: \"1.220,00\"", () => {
    expect(total("1.220,00")).toMatchObject({ kind: "ok", value: { net: 1000, tax: 220, total: 1220 } });
    expect(total("$ 12.200,00")).toMatchObject({ kind: "ok", value: { net: 10000, tax: 2200 } });
  });

  it("an exempt row, or one with IVA 0, has net equal to the total", () => {
    for (const taxCell of ["Exento", "exenta", "0", "0,00", "Sin IVA"]) {
      expect(total("1220", { taxCell })).toEqual({
        kind: "ok",
        value: { net: 1220, tax: 0, total: 1220, taxComputed: false },
      });
    }
  });

  it("uses the row's own IVA when the file brings one", () => {
    expect(total("1220", { taxCell: "220" })).toMatchObject({ kind: "ok", value: { net: 1000, tax: 220, taxComputed: false } });
  });

  it("net + IVA is always exactly the total, rounded to the currency", () => {
    const uy = total("1000");
    if (uy.kind !== "ok") throw new Error("expected ok");
    expect(uy.value).toMatchObject({ net: 819.67, tax: 180.33 });
    expect(uy.value.net + uy.value.tax).toBeCloseTo(1000, 10);

    const cl = total("1000", { vatRate: CL.vatRate, currency: "CLP" });
    if (cl.kind !== "ok") throw new Error("expected ok");
    expect(cl.value).toMatchObject({ net: 840, tax: 160 });
  });

  it("rejects what cannot be split, with the reason", () => {
    expect(total("1,234")).toMatchObject({ kind: "invalid", reason: expect.stringMatching(/^Importe inválido "1,234"/) });
    expect(total("1220", { taxCell: "veintidós" })).toMatchObject({ kind: "invalid", reason: expect.stringMatching(/^IVA inválido/) });
    expect(total("1220", { taxCell: "2000" })).toMatchObject({ kind: "invalid", reason: expect.stringMatching(/mayor que el total/) });
    expect(total("1220", { vatRate: null })).toMatchObject({ kind: "invalid", reason: expect.stringMatching(/tasa de IVA/) });
    expect(total("")).toEqual({ kind: "empty" });
  });
});

describe("resolveSaleAmounts with a net column (unchanged)", () => {
  it("keeps the net as read and the IVA from its column", () => {
    const net = (amountCell: string, taxCell: string | null) =>
      resolveSaleAmounts({ basis: "net", amountCell, taxCell, vatRate: 0.22, currency: "UYU" });
    expect(net("1.000,00", "220")).toEqual({ kind: "ok", value: { net: 1000, tax: 220, total: 1220, taxComputed: false } });
    expect(net("1000", null)).toEqual({ kind: "ok", value: { net: 1000, tax: 0, total: 1000, taxComputed: false } });
  });
});

describe("\"$\" in the Moneda column", () => {
  it("is the company's peso: UYU in Uruguay, CLP in Chile; ambiguous without a country", () => {
    expect(resolveRowCurrency(UY, "$  ", null)).toEqual({ kind: "ok", value: "UYU" });
    expect(resolveRowCurrency(UY, "U$S", null)).toEqual({ kind: "ok", value: "USD" });
    expect(resolveRowCurrency(CL, "$", null)).toEqual({ kind: "ok", value: "CLP" });
    expect(parseCurrencyCell("$", null).kind).toBe("invalid");
  });
});

describe("parseSaleTaxCell", () => {
  it("reads exempt words as exempt and numbers as numbers", () => {
    expect(parseSaleTaxCell("EXENTO")).toEqual({ kind: "exempt" });
    expect(parseSaleTaxCell("220,50")).toEqual({ kind: "ok", value: 220.5 });
    expect(parseSaleTaxCell("")).toEqual({ kind: "empty" });
  });
});

// --- commitImport: what reaches the database ---------------------------

const company = vi.hoisted(() => ({ current: { country: "UY", currency: "UYU", name: "Empresa de prueba" } }));
type RpcCall = { name: string; args: Record<string, unknown> };
const rpcCalls: RpcCall[] = [];

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc: (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      if (name === "create_import_batch") return Promise.resolve({ data: { id: "batch-1" }, error: null });
      if (name === "import_sales_rows_batch") {
        const sent = (args.p_rows as { row_number: number }[]).map((row) => ({
          row_number: row.row_number,
          status: "imported",
          error_message: null,
        }));
        return Promise.resolve({ data: sent, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
    from: () => ({
      insert: () => Promise.resolve({ error: null }),
      upsert: () => Promise.resolve({ error: null }),
    }),
  }),
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/salesAllocations", () => ({
  suggestAllocationsForImportBatch: async () => ({ created: 0, error: null }),
}));
vi.mock("@/lib/dal", () => ({
  getCompanyForEdit: async () => ({ company: company.current, role: "admin" }),
  getClients: async () => [{ id: "client-1", name: "Cliente Uno", active: true }],
  getClientAliases: async () => [],
}));

import { commitImport } from "@/app/companies/[id]/sales/import/actions";

const sentRows = () =>
  (rpcCalls.find((call) => call.name === "import_sales_rows_batch")?.args.p_rows as Record<string, unknown>[]) ?? [];

const totalMapping = {
  date: "Fecha",
  client: "Cliente",
  amount: "Total",
  amountBasis: "total_with_tax" as const,
  currency: null,
  tax: "IVA",
  taxId: null,
};

beforeEach(() => {
  rpcCalls.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("commitImport with a total with IVA included", () => {
  it("Uruguay: stores net and IVA split at 22 %, exempt rows as net = total", async () => {
    company.current = { country: "UY", currency: "UYU", name: "Empresa UY" };
    const rows = [
      { Fecha: "10/08/2026", Cliente: "Cliente Uno", Total: "1.220,00", IVA: "" },
      { Fecha: "11/08/2026", Cliente: "Cliente Uno", Total: "1220", IVA: "Exento" },
    ];
    const result = await commitImport("company-1", "f.csv", rows, totalMapping, [], [], "UYU");

    expect(result.error).toBeNull();
    expect(sentRows().map((row) => [row.amount, row.tax_amount, row.currency])).toEqual([
      [1000, 220, "UYU"],
      [1220, 0, "UYU"],
    ]);
  });

  it("Uruguay: a Moneda column with \"$\" (UYU) and \"U$S\" (USD), as the Uruguayan export writes them", async () => {
    company.current = { country: "UY", currency: "UYU", name: "Empresa UY" };
    const rows = [
      { Fecha: "2026-11-04", Cliente: "Cliente Uno", Total: "6832", Moneda: "$" },
      { Fecha: "2026-11-04", Cliente: "Cliente Uno", Total: "371.24", Moneda: "U$S" },
    ];
    const result = await commitImport("company-1", "f.csv", rows, { ...totalMapping, tax: null, currency: "Moneda" });

    expect(result.error).toBeNull();
    expect(sentRows().map((row) => [row.amount, row.tax_amount, row.currency])).toEqual([
      [5600, 1232, "UYU"],
      [304.3, 66.94, "USD"],
    ]);
  });

  it("Chile: stores net and IVA split at 19 %", async () => {
    company.current = { country: "CL", currency: "CLP", name: "Empresa CL" };
    const rows = [{ Fecha: "10/08/2026", Cliente: "Cliente Uno", Total: "1.190", IVA: "" }];
    const result = await commitImport("company-1", "f.csv", rows, totalMapping);

    expect(result.error).toBeNull();
    expect(sentRows().map((row) => [row.amount, row.tax_amount, row.currency])).toEqual([[1000, 190, "CLP"]]);
  });

  it("rejects a mapping whose amount basis is neither the net nor the total", async () => {
    const result = await commitImport(
      "company-1",
      "f.csv",
      [{ Fecha: "10/08/2026", Cliente: "Cliente Uno", Total: "1190" }],
      { ...totalMapping, amountBasis: "both" as unknown as "net" },
    );
    expect(result.error).toMatch(/neto o el total/);
    expect(sentRows()).toHaveLength(0);
  });
});
