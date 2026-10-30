/**
 * Boletas de honorarios (20261031030000) against the real inma-erp-dev project,
 * as a signed-in member (RLS on): the file's Neto is the bruto and its Total the
 * líquido, both stored apart from the retención; without a Total it comes from
 * the rate of the document's year; every other document has none. Amounts of
 * real document shapes, names invented.
 *
 * Run with `npm run test:integration`.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { anonClient, assertDevProject, serviceClient } from "./devProject";
import { purchaseRowCells, resolvePurchaseRow, type PurchaseColumnMapping } from "@/lib/purchaseImport";

const tag = `TEST_BOLETA ${randomUUID().slice(0, 6)}`;
const db = serviceClient();
const ids = { company: "", user: "", supplier: "" };
let member: SupabaseClient;

const MAPPING: PurchaseColumnMapping = {
  amount: "Neto",
  exempt: null,
  tax: "IVA",
  otherTaxes: null,
  total: "Total",
  documentType: "Tipo documento",
  documentNumber: "Nº documento",
  status: "Estado",
};

async function ok<T = unknown>(p: PromiseLike<{ data: unknown; error: unknown }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(JSON.stringify(error));
  return data as T;
}

type Stored = {
  document_number: string;
  net_amount: number;
  total_amount: number;
  withholding_amount: number;
  liquid_amount: number | null;
};

async function importRow(type: string, number: string, date: string, net: string, total: string, tax = "0") {
  const batch = await ok<{ id: string }>(
    member.rpc("create_cost_import_batch", { p_company_id: ids.company, p_file_name: `${tag}.csv`, p_total_rows: 1 }),
  );
  const row = { "Tipo documento": type, "Nº documento": number, Neto: net, IVA: tax, Total: total, Estado: "Válido" };
  const { amounts, error } = resolvePurchaseRow(purchaseRowCells(row, MAPPING));
  if (!amounts) throw new Error(error ?? "no amounts");
  const [result] = await ok<{ status: string; cost_document_id: string }[]>(
    member.rpc("import_cost_rows_batch", {
      p_import_batch_id: batch.id,
      p_rows: [
        {
          row_number: 1,
          raw_data: row,
          supplier_id: ids.supplier,
          document_date: date,
          currency: "CLP",
          amount: amounts.netAmount,
          tax_amount: amounts.taxAmount,
          withholding_amount: amounts.withholdingAmount,
          document_type: amounts.documentType,
          source_document_type: amounts.sourceDocumentType,
          document_number: amounts.documentNumber,
        },
      ],
    }),
  );
  expect(result.status).toBe("imported");
  return ok<Stored>(
    member
      .from("cost_documents")
      .select("document_number, net_amount, total_amount, withholding_amount, liquid_amount")
      .eq("id", result.cost_document_id)
      .single(),
  );
}

beforeAll(async () => {
  assertDevProject();
  const company = await ok<{ id: string }>(
    db.from("companies").insert({ name: tag, country: "CL", currency: "CLP" }).select("id").single(),
  );
  ids.company = company.id;
  const email = `test_boleta_${randomUUID().slice(0, 6)}@example.test`;
  const password = randomBytes(24).toString("base64url");
  const { data: user, error } = await db.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  ids.user = user.user.id;
  await ok(db.from("company_memberships").insert({ user_id: ids.user, company_id: ids.company, role: "admin" }).select("id"));
  member = anonClient();
  const { error: signInError } = await member.auth.signInWithPassword({ email, password });
  if (signInError) throw signInError;
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
      await step(db.from("cost_documents").update({ import_row_id: null }).in("id", costDocs));
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

describe("boleta amounts", () => {
  it("stores bruto, retención and líquido apart, from the file's Neto and Total", async () => {
    expect(await importRow("BOL-HE", "157", "2026-07-06", "589970", "500000")).toMatchObject({
      net_amount: 589970,
      total_amount: 589970,
      withholding_amount: 89970,
      liquid_amount: 500000,
    });
  });

  it("keeps a boleta without retención as the file says", async () => {
    expect(await importRow("BOL-HE", "97588", "2025-03-13", "29000", "29000")).toMatchObject({
      net_amount: 29000,
      withholding_amount: 0,
      liquid_amount: 29000,
    });
  });

  it("uses the rate of the document's year when the file has no Total, also for 2024", async () => {
    expect(await importRow("BOL-TE", "28", "2024-08-20", "579710", "")).toMatchObject({
      withholding_amount: 79710,
      liquid_amount: 500000,
    });
    expect(await importRow("BOL-HE", "2027", "2027-01-15", "100000", "")).toMatchObject({
      withholding_amount: 16000,
      liquid_amount: 84000,
    });
  });

  it("gives no retención nor líquido to any other document", async () => {
    expect(await importRow("FAC-EL", "9001", "2026-07-06", "100000", "119000", "19000")).toMatchObject({
      net_amount: 100000,
      total_amount: 119000,
      withholding_amount: 0,
      liquid_amount: null,
    });
  });

  it("does not let the retención change afterwards", async () => {
    const { data } = await member.from("cost_documents").select("id").eq("company_id", ids.company).eq("document_number", "157").single();
    const { error } = await member.from("cost_documents").update({ withholding_amount: 1 }).eq("id", data?.id as string);
    expect(error?.message).toMatch(/financial fields/);
  });

  it("has the rate of every year since 2020 in one table", async () => {
    const rates = await ok<{ year: number; rate: number }[]>(member.from("boleta_withholding_rates").select("year, rate").order("year"));
    expect(rates.map((row) => [row.year, row.rate])).toEqual([
      [2020, 0.1075],
      [2021, 0.115],
      [2022, 0.1225],
      [2023, 0.13],
      [2024, 0.1375],
      [2025, 0.145],
      [2026, 0.1525],
      [2027, 0.16],
      [2028, 0.17],
    ]);
  });
});
