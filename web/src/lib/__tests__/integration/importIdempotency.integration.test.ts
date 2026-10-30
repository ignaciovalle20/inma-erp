/**
 * Import deduplication backed by unique indexes (20261030020000), against the
 * real inma-erp-dev project as a signed-in member (RLS on):
 *
 * 1. Costs: re-importing the same file creates nothing (every row duplicate);
 *    two imports of the same file at the same time create each document once;
 *    "Importar igual" (force) still creates the second copy on purpose.
 * 2. Sales (generic importer, by folio): the same three checks, except that a
 *    folio is never forced (it is unique per company and type).
 *
 * Run with `npm run test:integration`.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { anonClient, assertDevProject, serviceClient } from "./devProject";

const tag = `TEST_DEDUP ${randomUUID().slice(0, 6)}`;
const db = serviceClient();
const ids = { company: "", user: "", supplier: "", client: "" };
let member: SupabaseClient;

async function ok<T = unknown>(p: PromiseLike<{ data: unknown; error: unknown }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(JSON.stringify(error));
  return data as T;
}

type RowResult = { row_number: number; status: string; error_message: string | null };

const COSTS = ["7001", "7002", "7003"].map((number) => ({ number, net: 10000, tax: 1900 }));

async function importCosts(force = false): Promise<RowResult[]> {
  const batch = await ok<{ id: string }>(
    member.rpc("create_cost_import_batch", { p_company_id: ids.company, p_file_name: `${tag}.csv`, p_total_rows: COSTS.length }),
  );
  return ok<RowResult[]>(
    member.rpc("import_cost_rows_batch", {
      p_import_batch_id: batch.id,
      p_rows: COSTS.map((doc, index) => ({
        row_number: index + 1,
        raw_data: { folio: doc.number },
        supplier_id: ids.supplier,
        document_date: "2026-08-14",
        currency: "CLP",
        amount: doc.net,
        exempt_amount: 0,
        tax_amount: doc.tax,
        other_taxes: 0,
        document_type: "invoice",
        source_document_type: "FAC-EL",
        document_number: doc.number,
        force,
        link_to_cost_document_id: null,
      })),
    }),
  );
}

const SALES = ["8001", "8002", "8003"];

async function importSales(): Promise<RowResult[]> {
  const batch = await ok<{ id: string }>(
    member.rpc("create_import_batch", { p_company_id: ids.company, p_file_name: `${tag}.csv`, p_total_rows: SALES.length }),
  );
  return ok<RowResult[]>(
    member.rpc("import_sales_rows_batch", {
      p_import_batch_id: batch.id,
      p_rows: SALES.map((number, index) => ({
        row_number: index + 1,
        raw_data: { folio: number },
        client_id: ids.client,
        document_date: "2026-08-14",
        currency: "CLP",
        amount: 50000,
        tax_amount: 9500,
        document_number: number,
        payment_status: null,
        paid_at: null,
        force: false,
      })),
    }),
  );
}

const countCosts = async () =>
  (await ok<{ id: string; duplicate_override: boolean }[]>(
    db.from("cost_documents").select("id, duplicate_override").eq("company_id", ids.company),
  ));
const countSales = async () =>
  (await ok<{ id: string }[]>(db.from("sales_documents").select("id").eq("company_id", ids.company))).length;
const statuses = (rows: RowResult[]) => rows.map((row) => row.status);

/** Removes this company's imported costs (and their batches), as the service role. */
async function resetCosts() {
  const docs = (await countCosts()).map((r) => r.id);
  const batches = ((await db.from("cost_import_batches").select("id").eq("company_id", ids.company)).data ?? []).map((r) => r.id);
  await ok(db.from("cost_documents").update({ import_row_id: null, duplicate_of_cost_document_id: null }).eq("company_id", ids.company).select("id"));
  if (batches.length) await ok(db.from("cost_import_rows").delete().in("import_batch_id", batches).select("id"));
  if (docs.length) await ok(db.from("cost_lines").delete().in("cost_document_id", docs).select("id"));
  await ok(db.from("cost_documents").delete().eq("company_id", ids.company).select("id"));
  await ok(db.from("cost_import_batches").delete().eq("company_id", ids.company).select("id"));
}

/** Same for imported sales. */
async function resetSales() {
  const sales = ((await db.from("sales_documents").select("id").eq("company_id", ids.company)).data ?? []).map((r) => r.id);
  const batches = ((await db.from("import_batches").select("id").eq("company_id", ids.company)).data ?? []).map((r) => r.id);
  await ok(db.from("sales_documents").update({ import_row_id: null }).eq("company_id", ids.company).select("id"));
  if (batches.length) await ok(db.from("import_rows").delete().in("import_batch_id", batches).select("id"));
  if (sales.length) await ok(db.from("sales_lines").delete().in("sales_document_id", sales).select("id"));
  await ok(db.from("sales_documents").delete().eq("company_id", ids.company).select("id"));
  await ok(db.from("import_batches").delete().eq("company_id", ids.company).select("id"));
}

beforeAll(async () => {
  assertDevProject();
  const company = await ok<{ id: string }>(
    db.from("companies").insert({ name: tag, country: "CL", currency: "CLP" }).select("id").single(),
  );
  ids.company = company.id;
  const email = `test_dedup_${randomUUID().slice(0, 6)}@example.test`;
  const password = randomBytes(24).toString("base64url");
  const { data: user, error } = await db.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  ids.user = user.user.id;
  await ok(db.from("company_memberships").insert({ user_id: ids.user, company_id: ids.company, role: "admin" }).select("id"));
  member = anonClient();
  const { error: signInError } = await member.auth.signInWithPassword({ email, password });
  if (signInError) throw signInError;
  ids.supplier = (
    await ok<{ id: string }>(member.from("suppliers").insert({ company_id: ids.company, name: `${tag} Proveedor` }).select("id").single())
  ).id;
  ids.client = (
    await ok<{ id: string }>(member.from("clients").insert({ company_id: ids.company, name: `${tag} Cliente` }).select("id").single())
  ).id;
}, 120_000);

afterAll(async () => {
  const failures: unknown[] = [];
  const step = async (p: PromiseLike<{ error: unknown }>) => {
    const { error } = await p;
    if (error) failures.push(error);
  };
  if (ids.company) {
    await resetCosts().catch((e) => failures.push(String(e)));
    await resetSales().catch((e) => failures.push(String(e)));
    await step(db.from("clients").delete().eq("company_id", ids.company));
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

describe("cost import: one document per supplier + type + folio", () => {
  it("re-importing the same file creates nothing", async () => {
    expect(statuses(await importCosts())).toEqual(["imported", "imported", "imported"]);
    expect(statuses(await importCosts())).toEqual(["duplicate", "duplicate", "duplicate"]);
    expect((await countCosts()).length).toBe(3);
  });

  it("two imports of the same file at the same time create each document once", async () => {
    await resetCosts();

    const [first, second] = await Promise.all([importCosts(), importCosts()]);
    const all = [...statuses(first), ...statuses(second)];
    expect(all.filter((s) => s === "imported")).toHaveLength(3);
    expect(all.filter((s) => s === "duplicate")).toHaveLength(3);
    expect(all.filter((s) => s === "error")).toHaveLength(0);
    expect((await countCosts()).length).toBe(3);
  });

  it("'Importar igual' still creates the copy on purpose", async () => {
    expect(statuses(await importCosts(true))).toEqual(["imported", "imported", "imported"]);
    const docs = await countCosts();
    expect(docs).toHaveLength(6);
    expect(docs.filter((d) => d.duplicate_override)).toHaveLength(3);
  });
});

describe("generic sales import: one document per folio", () => {
  it("re-importing the same file creates nothing", async () => {
    expect(statuses(await importSales())).toEqual(["imported", "imported", "imported"]);
    expect(statuses(await importSales())).toEqual(["duplicate", "duplicate", "duplicate"]);
    expect(await countSales()).toBe(3);
  });

  it("two imports of the same file at the same time create each folio once", async () => {
    await resetSales();

    const [first, second] = await Promise.all([importSales(), importSales()]);
    const all = [...statuses(first), ...statuses(second)];
    expect(all.filter((s) => s === "imported")).toHaveLength(3);
    expect(all.filter((s) => s === "duplicate")).toHaveLength(3);
    expect(all.filter((s) => s === "error")).toHaveLength(0);
    expect(await countSales()).toBe(3);
  });
});
