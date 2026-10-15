/**
 * Payment status, multi-currency summaries and the generic importer
 * (docs/cambios-pago-multimoneda-paridad-2026-10-14.md), end to end on
 * inma-erp-dev as a real signed-in member (RLS applies):
 *  1. A sale is Impaga by default; Pagada / Impaga one by one and in bulk,
 *     the payment date optional and cleared when it goes back to Impaga.
 *  2. The sales summary of a Uruguayan company with USD and UYU invoices:
 *     each currency apart, the combined total in UYU and USD with the rate
 *     of each invoice's date (nearest earlier snapshot), flagged incomplete
 *     when a date has no rate at all.
 *  3. The generic importer (column mapping) for a Uruguayan company: folio,
 *     currency, payment status and date mapped; an existing folio is never
 *     imported twice, but its imported payment status overwrites the one set
 *     by hand.
 * Every expected figure is worked out by hand below. Everything is deleted
 * in afterAll (1996 snapshot periods nobody else uses).
 */
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { anonClient, assertDevProject, serviceClient } from "./devProject";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let memberClient: SupabaseClient | null = null;
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    if (!memberClient) throw new Error("member client not ready");
    return memberClient;
  },
}));

import { getSalesListRows } from "@/lib/dal";
import { buildRateTable } from "@/lib/multiCurrency";
import { summarizeRows, type SalesViewRow } from "@/app/companies/[id]/sales/salesView";
import { setPaymentStatusAction } from "@/app/companies/[id]/sales/payment-actions";
import { commitImport } from "@/app/companies/[id]/sales/import/actions";

const PREFIX = "TEST_PAGO_";
const tag = randomUUID().slice(0, 6);
// 40 UYU = 1 USD in May 1996; nothing before May, nothing in June.
const MAY = "1996-05-01";
const FX = [{ currency: "UYU", period: MAY, ars_per_unit: 25, ars_per_usd: 1000 }];

const db = serviceClient();
const ids = { company: "", user: "", client: "", a: "", b: "", c: "" };
let member: SupabaseClient;
let folioA = "";

async function ok<T>(p: PromiseLike<{ data: unknown; error: unknown }>, what: string): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(`${what}: ${JSON.stringify(error)}`);
  return data as T;
}

async function sale(type: string, number: string | null, date: string, currency: string, net: number) {
  const row = await ok<{ id: string; payment_status: string; exchange_rate: number | null }>(
    member
      .from("sales_documents")
      .insert({
        company_id: ids.company,
        client_id: ids.client,
        document_type: type,
        document_number: number,
        document_date: date,
        currency,
        net_amount: net,
        tax_amount: 0,
        total_amount: net,
        source: "manual",
      })
      .select("id, payment_status, exchange_rate")
      .single(),
    `sale ${number ?? type}`,
  );
  return row;
}

function form(entries: [string, string][]) {
  const data = new FormData();
  for (const [key, value] of entries) data.append(key, value);
  return data;
}

async function statusOf(...saleIds: string[]) {
  const rows = await ok<{ id: string; payment_status: string; paid_at: string | null }[]>(
    db.from("sales_documents").select("id, payment_status, paid_at").in("id", saleIds),
    "status",
  );
  return Object.fromEntries(rows.map((row) => [row.id, { status: row.payment_status, paidAt: row.paid_at }]));
}

beforeAll(async () => {
  assertDevProject();

  const taken = await ok<unknown[]>(db.from("exchange_rate_snapshots").select("id").gte("period", "1996-01-01").lt("period", "1997-01-01"), "fx check");
  if (taken.length > 0) throw new Error("1996 exchange-rate snapshots already exist: refusing to touch them");
  await ok(db.from("exchange_rate_snapshots").insert(FX).select("id"), "fx insert");

  // "Uruguay" written out, like the real company: the configuration reads it as UY.
  const company = await ok<{ id: string }>(
    db.from("companies").insert({ name: `${PREFIX}UY ${tag}`, country: "Uruguay", currency: "UYU" }).select("id").single(),
    "company",
  );
  ids.company = company.id;

  const email = `test_pago_${tag}@example.test`;
  const password = randomBytes(24).toString("base64url");
  const { data: created, error } = await db.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  ids.user = created.user.id;
  member = anonClient();
  const { error: signInError } = await member.auth.signInWithPassword({ email, password });
  if (signInError) throw signInError;
  await ok(db.from("company_memberships").insert({ user_id: ids.user, company_id: ids.company, role: "admin" }).select("id"), "membership");
  memberClient = member;

  const client = await ok<{ id: string }>(
    member.from("clients").insert({ company_id: ids.company, name: `${PREFIX}Cliente ${tag}` }).select("id").single(),
    "client",
  );
  ids.client = client.id;

  folioA = `${PREFIX}A-${tag}`;
  const a = await sale("invoice", folioA, "1996-05-10", "USD", 1_000);
  const b = await sale("invoice", `${PREFIX}B-${tag}`, "1996-06-15", "UYU", 40_000);
  const c = await sale("manual", null, "1996-04-01", "UYU", 4_000);
  ids.a = a.id;
  ids.b = b.id;
  ids.c = c.id;
}, 120_000);

afterAll(async () => {
  const failures: string[] = [];
  const step = async (label: string, p: PromiseLike<{ error: unknown }>) => {
    const { error } = await p;
    if (error) failures.push(`${label}: ${JSON.stringify(error)}`);
  };
  if (ids.company) {
    const companies = [ids.company];
    const sales = ((await db.from("sales_documents").select("id").in("company_id", companies)).data ?? []).map((r) => r.id);
    const batches = ((await db.from("import_batches").select("id").in("company_id", companies)).data ?? []).map((r) => r.id);
    const none = ["00000000-0000-0000-0000-000000000000"];
    await step("unlink import rows", db.from("sales_documents").update({ import_row_id: null }).in("company_id", companies));
    await step("import rows", db.from("import_rows").delete().in("import_batch_id", batches.length ? batches : none));
    await step("sales lines", db.from("sales_lines").delete().in("sales_document_id", sales.length ? sales : none));
    await step("sales", db.from("sales_documents").delete().in("company_id", companies));
    await step("import batches", db.from("import_batches").delete().in("company_id", companies));
    await step("aliases", db.from("client_aliases").delete().in("company_id", companies));
    await step("clients", db.from("clients").delete().in("company_id", companies));
    await step("areas", db.from("business_areas").delete().in("company_id", companies));
    await step("memberships", db.from("company_memberships").delete().in("company_id", companies));
    await step("company", db.from("companies").delete().in("id", companies));
  }
  await step("fx", db.from("exchange_rate_snapshots").delete().gte("period", "1996-01-01").lt("period", "1997-01-01"));
  if (ids.user) {
    const { error } = await db.auth.admin.deleteUser(ids.user);
    if (error) failures.push(`user: ${error.message}`);
  }
  const left = (await db.from("companies").select("id", { count: "exact", head: true }).like("name", `${PREFIX}%${tag}`)).count;
  if (failures.length > 0 || left !== 0) throw new Error(`Cleanup incomplete (tag ${tag}): ${JSON.stringify({ failures, left })}`);
}, 300_000);

describe("1. Estado de pago: Pagada / Impaga", () => {
  it("a sale is Impaga by default, and keeps the rate of its own date", async () => {
    const rows = await ok<{ id: string; payment_status: string; exchange_rate: number | null }[]>(
      db.from("sales_documents").select("id, payment_status, exchange_rate").in("id", [ids.a, ids.b, ids.c]),
      "defaults",
    );
    expect(rows.every((row) => row.payment_status === "impago")).toBe(true);
    const byId = Object.fromEntries(rows.map((row) => [row.id, row.exchange_rate === null ? null : Number(row.exchange_rate)]));
    // USD -> UYU at May's 40; a UYU document needs no rate (1).
    expect(byId[ids.a]).toBe(40);
    expect(byId[ids.b]).toBe(1);
  });

  it("marks one sale paid with a date, then two in bulk without one", async () => {
    const one = await setPaymentStatusAction(
      ids.company,
      { error: null, message: null },
      form([["ids", ids.a], ["status", "pagado"], ["paid_at", "1996-05-20"]]),
    );
    expect(one.error).toBeNull();

    const bulk = await setPaymentStatusAction(
      ids.company,
      { error: null, message: null },
      form([["ids", ids.b], ["ids", ids.c], ["status", "pagado"], ["paid_at", ""]]),
    );
    expect(bulk).toEqual({ error: null, message: "2 ventas marcadas como pagadas" });

    expect(await statusOf(ids.a, ids.b, ids.c)).toEqual({
      [ids.a]: { status: "pagado", paidAt: "1996-05-20" },
      [ids.b]: { status: "pagado", paidAt: null },
      [ids.c]: { status: "pagado", paidAt: null },
    });
  });

  it("back to Impaga in bulk clears the payment date; the filter lists each state", async () => {
    const back = await setPaymentStatusAction(
      ids.company,
      { error: null, message: null },
      form([["ids", ids.a], ["ids", ids.b], ["status", "impago"], ["paid_at", "1996-06-01"]]),
    );
    expect(back.error).toBeNull();
    expect(await statusOf(ids.a, ids.b)).toEqual({
      [ids.a]: { status: "impago", paidAt: null },
      [ids.b]: { status: "impago", paidAt: null },
    });

    const unpaid = await getSalesListRows(ids.company, { paymentStatus: "impago" });
    const paid = await getSalesListRows(ids.company, { paymentStatus: "pagado" });
    expect(unpaid.map((row) => row.id).sort()).toEqual([ids.a, ids.b].sort());
    expect(paid.map((row) => row.id)).toEqual([ids.c]);
  });
});

describe("2. Resumen multimoneda de ventas (USD y UYU mezclados)", () => {
  it("each currency apart; combined in UYU and USD with each date's rate; incomplete without one", async () => {
    const rows = (await getSalesListRows(ids.company, {})).map(
      (row) => ({ ...row, cost: null, profit: null, marginPct: null }) as SalesViewRow,
    );
    const snapshots = await ok<{ currency: string; period: string; ars_per_unit: number; ars_per_usd: number }[]>(
      db.from("exchange_rate_snapshots").select("currency, period, ars_per_unit, ars_per_usd").gte("period", "1996-01-01").lt("period", "1997-01-01"),
      "fx read",
    );
    const totals = summarizeRows(rows, "UYU", buildRateTable(snapshots));

    // By hand: USD 1.000 (A) | UYU 40.000 (B) + 4.000 (C) = 44.000.
    expect(totals.net.byCurrency).toEqual([
      { currency: "USD", amount: 1_000, count: 1 },
      { currency: "UYU", amount: 44_000, count: 2 },
    ]);
    // UYU: A with its stored rate 40 = 40.000, plus 44.000 = 84.000.
    expect(totals.net.local).toBe(84_000);
    expect(totals.net.localComplete).toBe(true);
    // USD: A 1.000 + B 40.000/40 (June has no snapshot: May's) = 2.000;
    // C (April) has no rate on or before its date: left out, flagged.
    expect(totals.net.usd).toBeCloseTo(2_000, 6);
    expect(totals.net.usdComplete).toBe(false);
  });
});

describe("3. Importador genérico con mapeo (Uruguay)", () => {
  const mapping = {
    date: "Fecha",
    client: "Cliente",
    amount: "Neto",
    currency: "Moneda",
    tax: null,
    taxId: null,
    documentNumber: "Folio",
    paymentStatus: "Pago",
    paidAt: "Fecha pago",
  };
  const clientName = () => `${PREFIX}Cliente ${tag}`;

  it("imports by folio with currency and payment status, rejects what the company can't use", async () => {
    const result = await commitImport(ids.company, "ventas-uy.xlsx", [
      { Fecha: "20/05/1996", Folio: `${PREFIX}IMP-1-${tag}`, Cliente: clientName(), Neto: "1.500,50", Moneda: "US$", Pago: "Pagada", "Fecha pago": "25/05/1996" },
      { Fecha: "21/05/1996", Folio: `${PREFIX}IMP-2-${tag}`, Cliente: `${PREFIX}Nuevo ${tag}`, Neto: "10000", Moneda: "UYU", Pago: "Impaga", "Fecha pago": "" },
      { Fecha: "22/05/1996", Folio: `${PREFIX}IMP-3-${tag}`, Cliente: clientName(), Neto: "500", Moneda: "CLP", Pago: "", "Fecha pago": "" },
      { Fecha: "22/05/1996", Folio: `${PREFIX}IMP-4-${tag}`, Cliente: clientName(), Neto: "500", Moneda: "USD", Pago: "quizás", "Fecha pago": "" },
      // Already in the ERP (impaga, set by hand above): not created again,
      // but the imported status wins.
      { Fecha: "10/05/1996", Folio: folioA, Cliente: clientName(), Neto: "1000", Moneda: "USD", Pago: "Pagada", "Fecha pago": "" },
    ], mapping);

    if (result.error !== null) throw new Error(result.error);
    expect(result).toMatchObject({ totalRows: 5, importedRows: 2, errorRows: 2, updatedRows: 1, duplicateRows: 0 });
    expect(result.rowResults.map((row) => row.status)).toEqual(["imported", "imported", "error", "error", "updated"]);
    expect(result.rowResults[2].message).toMatch(/Moneda inválida.*CLP/);
    expect(result.rowResults[3].message).toMatch(/Estado de pago inválido/);

    const imported = await ok<{ document_number: string; document_type: string; currency: string; net_amount: number; payment_status: string; paid_at: string | null }[]>(
      db
        .from("sales_documents")
        .select("document_number, document_type, currency, net_amount, payment_status, paid_at")
        .eq("company_id", ids.company)
        .like("document_number", `${PREFIX}IMP-%`)
        .order("document_number"),
      "imported",
    );
    expect(imported.map((row) => ({ ...row, net_amount: Number(row.net_amount) }))).toEqual([
      { document_number: `${PREFIX}IMP-1-${tag}`, document_type: "invoice", currency: "USD", net_amount: 1500.5, payment_status: "pagado", paid_at: "1996-05-25" },
      { document_number: `${PREFIX}IMP-2-${tag}`, document_type: "invoice", currency: "UYU", net_amount: 10000, payment_status: "impago", paid_at: null },
    ]);
    expect((await statusOf(ids.a))[ids.a].status).toBe("pagado");
    const sameFolio = await ok<unknown[]>(
      db.from("sales_documents").select("id").eq("company_id", ids.company).eq("document_number", folioA),
      "folio A",
    );
    expect(sameFolio).toHaveLength(1);
  });

  it("re-importing ignores the folios already there, and their imported status overwrites the manual one", async () => {
    const imp2 = await ok<{ id: string }>(
      db.from("sales_documents").select("id").eq("company_id", ids.company).eq("document_number", `${PREFIX}IMP-2-${tag}`).single(),
      "imp2",
    );
    const result = await commitImport(ids.company, "ventas-uy-2.csv", [
      { Fecha: "20/05/1996", Folio: `${PREFIX}IMP-1-${tag}`, Cliente: clientName(), Neto: "1.500,50", Moneda: "USD", Pago: "", "Fecha pago": "" },
      { Fecha: "21/05/1996", Folio: `${PREFIX}IMP-2-${tag}`, Cliente: `${PREFIX}Nuevo ${tag}`, Neto: "10000", Moneda: "UYU", Pago: "Pagada", "Fecha pago": "30/05/1996" },
    ], mapping);

    if (result.error !== null) throw new Error(result.error);
    expect(result).toMatchObject({ importedRows: 0, duplicateRows: 1, updatedRows: 1, errorRows: 0 });
    expect(await statusOf(imp2.id)).toEqual({ [imp2.id]: { status: "pagado", paidAt: "1996-05-30" } });

    const batches = await ok<{ imported_rows: number; updated_rows: number; duplicate_rows: number; error_rows: number }[]>(
      db.from("import_batches").select("imported_rows, updated_rows, duplicate_rows, error_rows").eq("company_id", ids.company).order("imported_at"),
      "batches",
    );
    expect(batches).toEqual([
      { imported_rows: 2, updated_rows: 1, duplicate_rows: 0, error_rows: 2 },
      { imported_rows: 0, updated_rows: 1, duplicate_rows: 1, error_rows: 0 },
    ]);
  });
});
