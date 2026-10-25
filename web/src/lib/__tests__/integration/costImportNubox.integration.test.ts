/**
 * Purchase invoices from the Nubox purchases export (20261024050000)
 * against the real inma-erp-dev project, as a signed-in member (RLS on).
 * The rows go through lib/purchaseImport.ts like the Server Action does,
 * then through import_cost_rows_batch:
 *
 * 1. A factura exenta (Neto 0, Exento 105263) is imported with net 105263;
 *    a 100% exempt credit note (Exento 35319) is imported negative; a normal
 *    factura is stored as before.
 * 2. Two invoices of the same supplier, day and total but different numbers
 *    are two documents (they used to be taken as duplicates), and so is an
 *    invoice and its credit note of the same amount.
 * 3. Re-importing the same file finds every row as a duplicate.
 * 4. The monthly result adds the exempt invoice and subtracts the credit note.
 *
 * Run with `npm run test:integration`.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { anonClient, assertDevProject, serviceClient } from "./devProject";
import { purchaseRowCells, resolvePurchaseRow, type PurchaseColumnMapping } from "@/lib/purchaseImport";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let memberClient: SupabaseClient | null = null;
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    if (!memberClient) throw new Error("member client not ready");
    return memberClient;
  },
}));

import { computeMonthlyResult } from "@/lib/reporting";

const tag = `TEST_NUBOXCOST ${randomUUID().slice(0, 6)}`;
const db = serviceClient();
const ids = { company: "", user: "", supplier: "" };
let member: SupabaseClient;

const MAPPING: PurchaseColumnMapping = {
  amount: "Neto",
  exempt: "Exento",
  tax: "IVA",
  otherTaxes: "Otros impuestos",
  total: "Total",
  documentType: "Tipo documento",
  documentNumber: "Nº documento",
  status: "Estado",
};

const FILE = [
  { type: "FAC-EE", number: "501", net: "0", exempt: "105263", tax: "0", total: "105263" },
  { type: "N/C-EL", number: "77", net: "0", exempt: "35319", tax: "0", total: "35319" },
  { type: "FAC-EL", number: "9001", net: "403695", exempt: "0", tax: "76702", total: "480397" },
  // Same supplier, day and total as 9001: another invoice.
  { type: "FAC-EL", number: "9002", net: "403695", exempt: "0", tax: "76702", total: "480397" },
  // The credit note of 9002, same day and amount.
  { type: "N/C-EL", number: "78", net: "403695", exempt: "0", tax: "76702", total: "480397" },
].map((doc) => ({
  "Fecha emisión": "14/08/2026",
  "Tipo documento": doc.type,
  "Nº documento": doc.number,
  Proveedor: `${tag} Proveedor`,
  Neto: doc.net,
  Exento: doc.exempt,
  IVA: doc.tax,
  "Otros impuestos": "0",
  Total: doc.total,
  Estado: "Aceptado",
}));

async function ok<T = unknown>(p: PromiseLike<{ data: unknown; error: unknown }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(JSON.stringify(error));
  return data as T;
}

/** The file through the same steps as commitImport: resolve, then the batch RPC. */
async function importFile(rows: Record<string, string>[]) {
  const batch = await ok<{ id: string }>(
    member.rpc("create_cost_import_batch", { p_company_id: ids.company, p_file_name: `${tag}.csv`, p_total_rows: rows.length }),
  );
  const payload = rows.map((row, index) => {
    const { amounts, error } = resolvePurchaseRow(purchaseRowCells(row, MAPPING));
    if (!amounts) throw new Error(`row ${index + 1}: ${error}`);
    return {
      row_number: index + 1,
      raw_data: row,
      supplier_id: ids.supplier,
      document_date: "2026-08-14",
      currency: "CLP",
      amount: amounts.netAmount,
      exempt_amount: amounts.exemptAmount,
      tax_amount: amounts.taxAmount,
      other_taxes: amounts.otherTaxes,
      document_type: amounts.documentType,
      source_document_type: amounts.sourceDocumentType,
      document_number: amounts.documentNumber,
      force: false,
      link_to_cost_document_id: null,
    };
  });
  return ok<{ row_number: number; status: string; error_message: string | null; cost_document_id: string | null }[]>(
    member.rpc("import_cost_rows_batch", { p_import_batch_id: batch.id, p_rows: payload }),
  );
}

beforeAll(async () => {
  assertDevProject();
  const company = await ok<{ id: string }>(
    db.from("companies").insert({ name: tag, country: "CL", currency: "CLP" }).select("id").single(),
  );
  ids.company = company.id;
  const email = `test_nuboxcost_${randomUUID().slice(0, 6)}@example.test`;
  const password = randomBytes(24).toString("base64url");
  const { data: user, error } = await db.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  ids.user = user.user.id;
  await ok(db.from("company_memberships").insert({ user_id: ids.user, company_id: ids.company, role: "admin" }).select("id"));
  member = anonClient();
  const { error: signInError } = await member.auth.signInWithPassword({ email, password });
  if (signInError) throw signInError;
  memberClient = member;
  const supplier = await ok<{ id: string }>(
    member.from("suppliers").insert({ company_id: ids.company, name: `${tag} Proveedor` }).select("id").single(),
  );
  ids.supplier = supplier.id;
}, 120_000);

afterAll(async () => {
  const failures: unknown[] = [];
  const step = async (p: PromiseLike<{ error: unknown }>) => {
    const { error } = await p;
    if (error) failures.push(error);
  };
  if (ids.company) {
    const costDocs = ((await db.from("cost_documents").select("id").eq("company_id", ids.company)).data ?? []).map((r) => r.id);
    const batches = ((await db.from("cost_import_batches").select("id").eq("company_id", ids.company)).data ?? []).map((r) => r.id);
    if (costDocs.length) {
      await step(db.from("cost_documents").update({ import_row_id: null, duplicate_of_cost_document_id: null }).in("id", costDocs));
      await step(db.from("cost_lines").delete().in("cost_document_id", costDocs));
    }
    if (batches.length) await step(db.from("cost_import_rows").delete().in("import_batch_id", batches));
    await step(db.from("cost_documents").delete().eq("company_id", ids.company));
    await step(db.from("cost_import_batches").delete().eq("company_id", ids.company));
    await step(db.from("suppliers").delete().eq("company_id", ids.company));
    await step(db.from("company_memberships").delete().eq("company_id", ids.company));
    await step(db.from("business_areas").delete().eq("company_id", ids.company));
    await step(db.from("companies").delete().eq("id", ids.company));
  }
  if (ids.user) {
    const { error } = await db.auth.admin.deleteUser(ids.user);
    if (error) failures.push(error);
  }
  if (failures.length) throw new Error(`cleanup failed (${tag}): ${JSON.stringify(failures)}`);
}, 120_000);

describe("Nubox purchases export -> import_cost_rows_batch", () => {
  it("imports exempt documents, subtracts credit notes and tells documents apart by number", async () => {
    const results = await importFile(FILE);
    expect(results.map((row) => [row.row_number, row.status, row.error_message])).toEqual([
      [1, "imported", null],
      [2, "imported", null],
      [3, "imported", null],
      [4, "imported", null],
      [5, "imported", null],
    ]);

    const documents = await ok<
      {
        document_number: string;
        source_document_type: string;
        document_type: string;
        net_amount: number;
        exempt_amount: number;
        tax_amount: number;
        other_taxes: number;
        total_amount: number;
        cost_lines: { amount: number }[];
      }[]
    >(
      member
        .from("cost_documents")
        .select("document_number, source_document_type, document_type, net_amount, exempt_amount, tax_amount, other_taxes, total_amount, cost_lines(amount)")
        .eq("company_id", ids.company)
        .order("document_number"),
    );
    const byNumber = new Map(documents.map((doc) => [doc.document_number, doc]));

    expect(byNumber.get("501")).toMatchObject({
      source_document_type: "FAC-EE",
      document_type: "invoice",
      net_amount: 105263,
      exempt_amount: 105263,
      tax_amount: 0,
      total_amount: 105263,
      cost_lines: [{ amount: 105263 }],
    });
    expect(byNumber.get("77")).toMatchObject({
      document_type: "credit_note",
      net_amount: -35319,
      exempt_amount: -35319,
      total_amount: -35319,
      cost_lines: [{ amount: -35319 }],
    });
    expect(byNumber.get("9001")).toMatchObject({
      document_type: "invoice",
      net_amount: 403695,
      exempt_amount: 0,
      tax_amount: 76702,
      other_taxes: 0,
      total_amount: 480397,
    });
    expect(byNumber.get("9002")?.total_amount).toBe(480397);
    expect(byNumber.get("78")).toMatchObject({ document_type: "credit_note", net_amount: -403695, total_amount: -480397 });
  });

  it("finds every row of the same file as a duplicate when it is imported again", async () => {
    const results = await importFile(FILE);
    expect(results.map((row) => row.status)).toEqual(["duplicate", "duplicate", "duplicate", "duplicate", "duplicate"]);
    const { count } = await member
      .from("cost_documents")
      .select("id", { count: "exact", head: true })
      .eq("company_id", ids.company);
    expect(count).toBe(5);
  });

  it("refuses a negative amount sent straight to the database", async () => {
    const batch = await ok<{ id: string }>(
      member.rpc("create_cost_import_batch", { p_company_id: ids.company, p_file_name: `${tag}-neg.csv`, p_total_rows: 1 }),
    );
    const results = await ok<{ status: string; error_message: string }[]>(
      member.rpc("import_cost_rows_batch", {
        p_import_batch_id: batch.id,
        p_rows: [{ row_number: 1, raw_data: {}, supplier_id: ids.supplier, document_date: "2026-08-15", currency: "CLP", amount: -500, document_type: "credit_note" }],
      }),
    );
    expect(results).toMatchObject([{ status: "error", error_message: "Neto + Exento en 0 o vacío" }]);
  });

  it("counts the exempt invoice and subtracts the credit notes in the monthly result", async () => {
    const august = await computeMonthlyResult(ids.company, "2026-08-01");
    expect(august.hasError, JSON.stringify(august.errors)).toBe(false);
    expect(august.generalCostDocuments).toBe(105263 - 35319 + 403695 + 403695 - 403695);
  });
});
