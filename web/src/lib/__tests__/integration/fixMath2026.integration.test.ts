/**
 * fix-math 2026-11 (migration 20261108020000) against the real inma-erp-dev
 * project, as a signed-in member (RLS applies). Golden cases worked out by
 * hand; every row is deleted in afterAll. Months are in 2099 so nothing real
 * is in range.
 *
 *  1. MS licenses, split per invoice (fix-ms-invoice 2026-11, 20261109010000):
 *     ms_license_invoices suggests one licenses invoice per supplier-month;
 *     the preview (recurring_service_cost_pool_shares) is exactly the split
 *     create_ms_license_pool_for_invoice saves, only that invoice's net; the
 *     supplier's other invoices stay general costs; a second licenses invoice
 *     needs a confirmation; a split can be undone; only services that use the
 *     pool take part; the cost is recognised in the pool's month while the
 *     sale cycles are still pending.
 *  2. Uruguay: a charge "sin documento de respaldo" is exactly what is paid,
 *     no IVA; Chile keeps its own RPCs.
 *  3. A recurring period is "pagado" when its invoices are collected, even if
 *     billed differs from its price (the difference is information).
 *
 * Run with `npm run test:integration`.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { anonClient, assertDevProject, serviceClient } from "./devProject";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let member: SupabaseClient;
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => member,
}));

import { computeMonthlyResult } from "@/lib/reporting";

const tag = `TEST_FIXMATH ${randomUUID().slice(0, 6)}`;
const db = serviceClient();
const ids = {
  cl: "",
  uy: "",
  user: "",
  clClient: "",
  uyClient: "",
  intcomex: "",
  tgm: "",
};
const MONTH = "2099-05-01";

async function ok<T = unknown>(p: PromiseLike<{ data: unknown; error: unknown }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(JSON.stringify(error));
  return data as T;
}

async function msService(companyId: string, clientId: string, name: string, fields: Record<string, unknown>) {
  const row = await ok<{ id: string }>(
    member
      .from("recurring_services")
      .insert({
        company_id: companyId,
        client_id: clientId,
        name: `${tag} ${name}`,
        periodicity: "monthly",
        invoicing_mode: "advance",
        start_date: "2099-01-01",
        status: "active",
        active: true,
        service_type: "ms_licenses",
        ...fields,
      })
      .select("id")
      .single(),
  );
  return row.id;
}

async function supplierInvoice(companyId: string, supplierId: string, currency: string, date: string, net: number) {
  const row = await ok<{ id: string }>(
    member.rpc("create_cost_document", {
      p_company_id: companyId,
      p_supplier_id: supplierId,
      p_project_id: null,
      p_classification: "general",
      p_document_date: date,
      p_currency: currency,
      p_tax_amount: 0,
      p_lines: [{ description: `${tag} licencias`, amount: net }],
    }),
  );
  return row.id;
}

beforeAll(async () => {
  assertDevProject();
  const cl = await ok<{ id: string }>(db.from("companies").insert({ name: `${tag} CL`, country: "CL", currency: "CLP" }).select("id").single());
  const uy = await ok<{ id: string }>(db.from("companies").insert({ name: `${tag} UY`, country: "UY", currency: "UYU" }).select("id").single());
  ids.cl = cl.id;
  ids.uy = uy.id;
  const email = `test_fixmath_${randomUUID().slice(0, 6)}@example.test`;
  const password = randomBytes(24).toString("base64url");
  const { data: user, error } = await db.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  ids.user = user.user.id;
  await ok(
    db.from("company_memberships").insert([
      { user_id: ids.user, company_id: ids.cl, role: "admin" },
      { user_id: ids.user, company_id: ids.uy, role: "admin" },
    ]).select("id"),
  );
  member = anonClient();
  const { error: signInError } = await member.auth.signInWithPassword({ email, password });
  if (signInError) throw signInError;
  ids.clClient = (await ok<{ id: string }>(member.from("clients").insert({ company_id: ids.cl, name: `${tag} cliente` }).select("id").single())).id;
  ids.uyClient = (await ok<{ id: string }>(member.from("clients").insert({ company_id: ids.uy, name: `${tag} cliente` }).select("id").single())).id;
  ids.intcomex = (await ok<{ id: string }>(member.from("suppliers").insert({ company_id: ids.cl, name: `Intcomex S.A. ${tag}` }).select("id").single())).id;
  ids.tgm = (await ok<{ id: string }>(member.from("suppliers").insert({ company_id: ids.uy, name: `TGM S.A. ${tag}` }).select("id").single())).id;
}, 120_000);

afterAll(async () => {
  const failures: string[] = [];
  const step = async (label: string, p: PromiseLike<{ error: unknown }>) => {
    const { error } = await p;
    if (error) failures.push(`${label}: ${JSON.stringify(error)}`);
  };
  const companies = [ids.cl, ids.uy].filter(Boolean);
  const none = ["00000000-0000-0000-0000-000000000000"];
  const list = (values: string[]) => (values.length ? values : none);
  if (companies.length) {
    const services = ((await db.from("recurring_services").select("id").in("company_id", companies)).data ?? []).map((r) => r.id);
    const pools = ((await db.from("recurring_service_cost_pools").select("id").in("company_id", companies)).data ?? []).map((r) => r.id);
    const costDocs = ((await db.from("cost_documents").select("id").in("company_id", companies)).data ?? []).map((r) => r.id);
    const sales = ((await db.from("sales_documents").select("id").in("company_id", companies)).data ?? []).map((r) => r.id);
    await step("pool shares", db.from("recurring_service_cost_allocations").delete().in("cost_pool_id", list(pools)));
    await step("pools", db.from("recurring_service_cost_pools").delete().in("company_id", companies));
    await step("sales allocations", db.from("sales_allocations").delete().in("company_id", companies));
    await step("occurrences", db.from("recurring_service_occurrences").delete().in("recurring_service_id", list(services)));
    await step("cost periods", db.from("recurring_service_cost_periods").delete().in("company_id", companies));
    await step("services", db.from("recurring_services").delete().in("company_id", companies));
    await step("tech charges", db.from("technician_charges").delete().in("company_id", companies));
    await step("personnel", db.from("personnel").delete().in("company_id", companies));
    await step("cost lines", db.from("cost_lines").delete().in("cost_document_id", list(costDocs)));
    await step("cost docs", db.from("cost_documents").delete().in("company_id", companies));
    await step("sales lines", db.from("sales_lines").delete().in("sales_document_id", list(sales)));
    await step("sales", db.from("sales_documents").delete().in("company_id", companies));
    await step("projects", db.from("projects").delete().in("company_id", companies));
    await step("suppliers", db.from("suppliers").delete().in("company_id", companies));
    await step("clients", db.from("clients").delete().in("company_id", companies));
    await step("areas", db.from("business_areas").delete().in("company_id", companies));
    await step("memberships", db.from("company_memberships").delete().in("company_id", companies));
    await step("companies", db.from("companies").delete().in("id", companies));
  }
  if (ids.user) {
    const { error } = await db.auth.admin.deleteUser(ids.user);
    if (error) failures.push(`user: ${JSON.stringify(error)}`);
  }
  if (failures.length) throw new Error(`cleanup failed (${tag}): ${failures.join("; ")}`);
}, 120_000);

type InvoiceRow = {
  cost_document_id: string;
  period: string;
  net_amount: number;
  assigned: boolean;
  pool_id: string | null;
  legacy_pool_id: string | null;
  reference_net: number | null;
  suggested: boolean;
};

const invoicesOf = (companyId: string) => ok<InvoiceRow[]>(member.rpc("ms_license_invoices", { p_company_id: companyId }));
const coveredBy = async (documentId: string) =>
  (await ok<{ covered_by_cost_pool_id: string | null }>(
    member.from("cost_documents").select("covered_by_cost_pool_id").eq("id", documentId).single(),
  )).covered_by_cost_pool_id;

describe("MS licenses split per invoice (fix-ms-invoice 2026-11)", () => {
  it("Chile / Intcomex: only the licenses invoice is split, the hardware one stays a general cost", async () => {
    // A: advance, sold 600 (expected). B: arrears, 400 -- its May cycle is only
    // created by the split itself. C: does not use the pool: no part.
    const a = await msService(ids.cl, ids.clClient, "MS A", { reference_amount: 600, currency: "CLP", uses_cost_pool: true });
    const b = await msService(ids.cl, ids.clClient, "MS B", { reference_amount: 400, currency: "CLP", uses_cost_pool: true, invoicing_mode: "arrears" });
    const c = await msService(ids.cl, ids.clClient, "MS C sin pool", { reference_amount: 1_000, currency: "CLP", uses_cost_pool: false });
    await ok(member.rpc("generate_recurring_service_occurrences_for_month", { p_month: MONTH, p_company_id: ids.cl, p_service_id: a }));
    await ok(member.rpc("generate_recurring_service_occurrences_for_month", { p_month: MONTH, p_company_id: ids.cl, p_service_id: c }));

    // May: the licenses invoice (1.001) and a hardware invoice (500) of Intcomex.
    const licenses = await supplierInvoice(ids.cl, ids.intcomex, "CLP", "2099-05-05", 1_001);
    const hardware = await supplierInvoice(ids.cl, ids.intcomex, "CLP", "2099-05-20", 500);

    // Without an earlier licenses invoice, the first of the month is suggested; one per month.
    const before = (await invoicesOf(ids.cl)).filter((row) => row.period === MONTH);
    expect(before).toHaveLength(2);
    expect(before.filter((row) => row.suggested).map((row) => row.cost_document_id)).toEqual([licenses]);
    expect(before.every((row) => row.pool_id === null && row.reference_net === null)).toBe(true);

    // Preview (what the screen shows before confirming): the invoice's net only.
    await ok(member.rpc("prepare_recurring_service_cost_pool_cycles", { p_company_id: ids.cl, p_service_type: "ms_licenses", p_period: MONTH }));
    const preview = await ok<{ occurrence_id: string; share: number; weight: number }[]>(
      member.rpc("recurring_service_cost_pool_shares", {
        p_company_id: ids.cl, p_service_type: "ms_licenses", p_period: MONTH, p_currency: "CLP", p_total: 1_001,
      }),
    );
    // 1.001 x 600/1.000 = 600,6 and x 400/1.000 = 400,4 -> 600 / 400 + 1 to the larger remainder: 601 / 400.
    expect(preview.map((row) => Number(row.share)).sort((x, y) => x - y)).toEqual([400, 601]);

    const poolId = await ok<string>(member.rpc("create_ms_license_pool_for_invoice", { p_cost_document_id: licenses }));
    const pool = await ok<{ total_expense_amount: number; cost_document_id: string; period: string; supplier_id: string }>(
      member.from("recurring_service_cost_pools").select("total_expense_amount, cost_document_id, period, supplier_id").eq("id", poolId).single(),
    );
    expect(pool).toMatchObject({ cost_document_id: licenses, period: MONTH, supplier_id: ids.intcomex });
    expect(Number(pool.total_expense_amount)).toBe(1_001);
    const saved = await ok<{ occurrence_id: string; allocated_amount: number }[]>(
      member.from("recurring_service_cost_allocations").select("occurrence_id, allocated_amount").eq("cost_pool_id", poolId),
    );
    const byOccurrence = (rows: { occurrence_id: string }[], value: (row: never) => number) =>
      Object.fromEntries(rows.map((row) => [row.occurrence_id, value(row as never)]));
    expect(byOccurrence(saved, (row: { allocated_amount: number }) => Number(row.allocated_amount))).toEqual(
      byOccurrence(preview, (row: { share: number }) => Number(row.share)),
    );
    expect(saved.reduce((sum, row) => sum + Number(row.allocated_amount), 0)).toBe(1_001);

    // C (not pooled) has a May cycle and no part.
    const cCycle = await ok<{ id: string }>(member.from("recurring_service_occurrences").select("id").eq("recurring_service_id", c).eq("period", MONTH).single());
    expect(saved.some((row) => row.occurrence_id === cCycle.id)).toBe(false);

    // Only the licenses invoice is covered; the hardware one is not, and the
    // month has no suggestion any more.
    expect(await coveredBy(licenses)).toBe(poolId);
    expect(await coveredBy(hardware)).toBeNull();
    const after = (await invoicesOf(ids.cl)).filter((row) => row.period === MONTH);
    expect(after.some((row) => row.suggested)).toBe(false);

    // Recognised in May while both sale cycles are still pending_invoice: the
    // licenses' 1.001 are direct (recurring) costs; the hardware's 500, general.
    const result = await computeMonthlyResult(ids.cl, MONTH);
    expect(result.hasError).toBe(false);
    expect(result.directCosts).toBe(1_001);
    expect(result.recurringCosts).toBe(1_001);
    expect(result.generalCosts).toBe(500);

    // A second licenses invoice of the month is never added silently.
    const second = await member.rpc("create_ms_license_pool_for_invoice", { p_cost_document_id: hardware });
    expect(second.error?.message).toMatch(/^SECOND: .*ya tiene una factura de licencias repartida/);
    expect(await coveredBy(hardware)).toBeNull();
    // Confirmed (a re-billing): its own split, exactly its net.
    const secondPool = await ok<string>(member.rpc("create_ms_license_pool_for_invoice", { p_cost_document_id: hardware, p_allow_second: true }));
    const secondShares = await ok<{ allocated_amount: number }[]>(
      member.from("recurring_service_cost_allocations").select("allocated_amount").eq("cost_pool_id", secondPool),
    );
    expect(secondShares.reduce((sum, row) => sum + Number(row.allocated_amount), 0)).toBe(500);
    // ...and undone: the hardware invoice is a general cost again.
    await ok(member.rpc("undo_recurring_service_cost_pool", { p_cost_pool_id: secondPool }));
    expect(await coveredBy(hardware)).toBeNull();
    expect((await ok<unknown[]>(member.from("recurring_service_cost_allocations").select("id").eq("cost_pool_id", secondPool))).length).toBe(0);

    // The same invoice twice: refused.
    const again = await member.rpc("create_ms_license_pool_for_invoice", { p_cost_document_id: licenses });
    expect(again.error?.message).toMatch(/^EXISTS/);

    // The split invoice cannot be deleted or moved to a job while it has its split.
    const deleted = await member.rpc("delete_cost_document", { p_cost_document_id: licenses });
    expect(deleted.error?.message).toMatch(/deshacé el reparto/);
    const area = await ok<{ id: string }>(db.from("business_areas").insert({ company_id: ids.cl, name: `${tag} área MS` }).select("id").single());
    const job = await ok<{ id: string }>(
      db.from("projects").insert({ company_id: ids.cl, client_id: ids.clClient, business_area_id: area.id, name: `${tag} trabajo MS`, status: "en_ejecucion" }).select("id").single(),
    );
    const split = await member.from("cost_allocations").insert({ cost_document_id: licenses, project_id: job.id, method: "percentage", percentage: 100 });
    expect(split.error?.message).toMatch(/deshacé el reparto/);

    // June: 300 (the 2nd) and 990 (the 10th). The suggestion is the closest to
    // May's licenses invoice (1.001), not the first of the month.
    const juneSmall = await supplierInvoice(ids.cl, ids.intcomex, "CLP", "2099-06-02", 300);
    const juneLicenses = await supplierInvoice(ids.cl, ids.intcomex, "CLP", "2099-06-10", 990);
    const june = (await invoicesOf(ids.cl)).filter((row) => row.period === "2099-06-01");
    expect(june.filter((row) => row.suggested).map((row) => row.cost_document_id)).toEqual([juneLicenses]);
    expect(june.every((row) => Number(row.reference_net) === 1_001)).toBe(true);
    void juneSmall;

    // A job's Intcomex invoice is never a candidate.
    const jobInvoice = await ok<{ id: string }>(
      member.rpc("create_cost_document", {
        p_company_id: ids.cl, p_supplier_id: ids.intcomex, p_project_id: job.id, p_classification: "direct",
        p_document_date: "2099-06-03", p_currency: "CLP", p_tax_amount: 0, p_lines: [{ description: `${tag} switch`, amount: 2_000 }],
      }),
    );
    const assigned = (await invoicesOf(ids.cl)).find((row) => row.cost_document_id === jobInvoice.id);
    expect(assigned).toMatchObject({ assigned: true, suggested: false });
    const refusedJob = await member.rpc("create_ms_license_pool_for_invoice", { p_cost_document_id: jobInvoice.id });
    expect(refusedJob.error?.message).toMatch(/^ASSIGNED/);

    // Undo the May split: the licenses invoice is a general cost again and May
    // is suggested again.
    await ok(member.rpc("undo_recurring_service_cost_pool", { p_cost_pool_id: poolId }));
    expect(await coveredBy(licenses)).toBeNull();
    const undone = (await invoicesOf(ids.cl)).filter((row) => row.period === MONTH);
    expect(undone.filter((row) => row.suggested).map((row) => row.cost_document_id)).toEqual([licenses]);
    void b;
  });

  it("a pool typed by hand still covers its month, and blocks a split per invoice until it is undone", async () => {
    const LEGACY = "2099-08-01";
    const doc = await supplierInvoice(ids.cl, ids.intcomex, "CLP", "2099-08-04", 777);
    const legacy = await ok<{ id: string }>(
      db.from("recurring_service_cost_pools").insert({
        company_id: ids.cl, service_type: "ms_licenses", period: LEGACY, total_expense_amount: 777, currency: "CLP", supplier_id: ids.intcomex,
      }).select("id").single(),
    );
    expect(await coveredBy(doc)).toBe(legacy.id);
    const row = (await invoicesOf(ids.cl)).find((invoice) => invoice.cost_document_id === doc);
    expect(row).toMatchObject({ legacy_pool_id: legacy.id, suggested: false });
    const refused = await member.rpc("create_ms_license_pool_for_invoice", { p_cost_document_id: doc });
    expect(refused.error?.message).toMatch(/^LEGACY/);

    await ok(member.rpc("undo_recurring_service_cost_pool", { p_cost_pool_id: legacy.id }));
    expect(await coveredBy(doc)).toBeNull();
  });

  it("Volver a repartir takes the invoice's current net", async () => {
    const SEP = "2099-09-01";
    await msService(ids.cl, ids.clClient, "MS sep", { reference_amount: 100, currency: "CLP", uses_cost_pool: true, start_date: "2099-09-01" });
    const doc = await supplierInvoice(ids.cl, ids.intcomex, "CLP", "2099-09-03", 120);
    const poolId = await ok<string>(member.rpc("create_ms_license_pool_for_invoice", { p_cost_document_id: doc }));
    // The pool's total drifts from its invoice (typed over by hand).
    await ok(db.from("recurring_service_cost_pools").update({ total_expense_amount: 150 }).eq("id", poolId).select("id"));
    await ok(member.rpc("reallocate_recurring_service_cost_pool", { p_cost_pool_id: poolId }));
    const pool = await ok<{ total_expense_amount: number; period: string }>(
      member.from("recurring_service_cost_pools").select("total_expense_amount, period").eq("id", poolId).single(),
    );
    expect(pool.period).toBe(SEP);
    expect(Number(pool.total_expense_amount)).toBe(120);
    const shares = await ok<{ allocated_amount: number }[]>(
      member.from("recurring_service_cost_allocations").select("allocated_amount").eq("cost_pool_id", poolId),
    );
    expect(shares.reduce((sum, share) => sum + Number(share.allocated_amount), 0)).toBe(120);
  });

  it("Uruguay / TGM: no part for services without the pool; once they use it, the whole invoice is theirs", async () => {
    const trimant = await msService(ids.uy, ids.uyClient, "Trimant", { reference_amount: 279.1, currency: "USD", uses_cost_pool: false, invoicing_mode: "arrears" });
    const doc = await supplierInvoice(ids.uy, ids.tgm, "USD", "2099-05-08", 85.37);

    const refused = await member.rpc("create_ms_license_pool_for_invoice", { p_cost_document_id: doc });
    expect(refused.error?.message).toMatch(/^NO_CYCLES/);
    expect((await ok<unknown[]>(member.from("recurring_service_cost_pools").select("id").eq("company_id", ids.uy))).length).toBe(0);

    await ok(member.from("recurring_services").update({ uses_cost_pool: true }).eq("id", trimant).select("id"));
    const poolId = await ok<string>(member.rpc("create_ms_license_pool_for_invoice", { p_cost_document_id: doc }));
    const pool = await ok<{ total_expense_amount: number; currency: string }>(
      member.from("recurring_service_cost_pools").select("total_expense_amount, currency").eq("id", poolId).single(),
    );
    expect(pool).toMatchObject({ currency: "USD" });
    expect(Number(pool.total_expense_amount)).toBe(85.37);
    const shares = await ok<{ allocated_amount: number }[]>(
      member.from("recurring_service_cost_allocations").select("allocated_amount").eq("cost_pool_id", poolId),
    );
    expect(shares.map((row) => Number(row.allocated_amount))).toEqual([85.37]);
  });

  it("a document of another supplier is not a licenses invoice", async () => {
    const other = (await ok<{ id: string }>(member.from("suppliers").insert({ company_id: ids.cl, name: `${tag} Otro` }).select("id").single())).id;
    const doc = await supplierInvoice(ids.cl, other, "CLP", "2099-05-07", 50);
    const refused = await member.rpc("create_ms_license_pool_for_invoice", { p_cost_document_id: doc });
    expect(refused.error?.message).toMatch(/^NOT_SUPPLIER/);
  });
});

describe("Uruguay: charge without backing (sin documento de respaldo)", () => {
  async function fixtures(companyId: string, clientId: string) {
    const area = await ok<{ id: string }>(
      db.from("business_areas").insert({ company_id: companyId, name: `${tag} área ${randomUUID().slice(0, 4)}` }).select("id").single(),
    );
    const project = await ok<{ id: string }>(
      db
        .from("projects")
        .insert({ company_id: companyId, client_id: clientId, business_area_id: area.id, name: `${tag} trabajo`, status: "en_ejecucion" })
        .select("id")
        .single(),
    );
    const tech = await ok<{ id: string }>(
      member.from("personnel").insert({ company_id: companyId, name: `${tag} técnico`, type: "contractor" }).select("id").single(),
    );
    return { project: project.id, tech: tech.id };
  }

  it("is exactly what is paid, no IVA; it can become an ordinary charge with IVA and back", async () => {
    const { project, tech } = await fixtures(ids.uy, ids.uyClient);
    const created = await ok<{ id: string; backing: string; vat_included: boolean; amount: number; net_amount: number; document_status: string; cost_document_id: string }>(
      member.rpc("create_unbacked_technician_charge", {
        p_project_id: project, p_personnel_id: tech, p_description: "visita", p_charge_date: "2099-05-10", p_amount: 1_500.5,
      }),
    );
    expect(created).toMatchObject({ backing: "none", vat_included: false, document_status: "no_aplica" });
    expect(Number(created.amount)).toBe(1_500.5);
    expect(Number(created.net_amount)).toBe(1_500.5);
    const doc = await ok<{ net_amount: number; tax_amount: number; total_amount: number }>(
      member.from("cost_documents").select("net_amount, tax_amount, total_amount").eq("id", created.cost_document_id).single(),
    );
    expect([Number(doc.net_amount), Number(doc.tax_amount), Number(doc.total_amount)]).toEqual([1_500.5, 0, 1_500.5]);

    // To an ordinary Uruguayan charge with IVA included: 1.220 -> net 1.000.
    const withVat = await ok<{ backing: string | null; vat_included: boolean; net_amount: number; document_status: string }>(
      member.rpc("update_uruguay_technician_charge", {
        p_charge_id: created.id, p_description: "visita", p_charge_date: "2099-05-10", p_amount: 1_220, p_vat_included: true, p_unbacked: false,
      }),
    );
    expect(withVat).toMatchObject({ backing: null, vat_included: true, document_status: "pendiente" });
    expect(Number(withVat.net_amount)).toBe(1_000);

    // Back without backing: the IVA box is ignored.
    const back = await ok<{ backing: string; vat_included: boolean; net_amount: number; amount: number }>(
      member.rpc("update_uruguay_technician_charge", {
        p_charge_id: created.id, p_description: "visita", p_charge_date: "2099-05-10", p_amount: 1_220, p_vat_included: true, p_unbacked: true,
      }),
    );
    expect(back).toMatchObject({ backing: "none", vat_included: false });
    expect(Number(back.net_amount)).toBe(1_220);
  });

  it("Chile keeps its own RPCs: this one is refused there", async () => {
    const { project, tech } = await fixtures(ids.cl, ids.clClient);
    const { error } = await member.rpc("create_unbacked_technician_charge", {
      p_project_id: project, p_personnel_id: tech, p_description: null, p_charge_date: "2099-05-10", p_amount: 1_000,
    });
    expect(error?.message).toMatch(/En Chile/);
  });
});

describe("recurring period: pagado follows the invoices, the price difference is information", () => {
  it("a period billed 500 against a price of 600 is 'paid' once its invoice is collected", async () => {
    const hosting = (await ok<{ id: string }>(
      member
        .from("recurring_services")
        .insert({
          company_id: ids.cl, client_id: ids.clClient, name: `${tag} hosting`, reference_amount: 600, currency: "CLP",
          periodicity: "monthly", invoicing_mode: "advance", start_date: "2099-01-01", status: "active", active: true, service_type: "hosting",
        })
        .select("id")
        .single(),
    )).id;
    await ok(member.rpc("generate_recurring_service_occurrences_for_month", { p_month: MONTH, p_company_id: ids.cl, p_service_id: hosting }));
    const period = await ok<{ id: string }>(member.from("recurring_service_occurrences").select("id").eq("recurring_service_id", hosting).eq("period", MONTH).single());
    const doc = (await ok<{ id: string }>(
      db
        .from("sales_documents")
        .insert({
          company_id: ids.cl, client_id: ids.clClient, document_type: "invoice", document_number: `F-${tag}`, document_date: "2099-05-03",
          currency: "CLP", net_amount: 500, tax_amount: 0, total_amount: 500, source: "import", payment_status: "impago",
        })
        .select("id")
        .single(),
    )).id;
    await ok(
      member.rpc("set_sales_allocations", {
        p_sales_document_id: doc,
        p_allocations: [{ target_type: "period", target_id: period.id, amount: 500, status: "confirmed" }],
      }),
    );
    const read = () =>
      ok<{ billing_status: string; difference: number; expected_amount: number; billed_amount: number; unpaid_amount: number }>(
        member
          .from("recurring_service_period_summary")
          .select("billing_status, difference, expected_amount, billed_amount, unpaid_amount")
          .eq("recurring_service_period_id", period.id)
          .single(),
      );
    expect((await read()).billing_status).toBe("invoiced");

    await ok(member.rpc("set_sales_documents_payment_status", { p_sales_document_ids: [doc], p_payment_status: "pagado", p_paid_at: "2099-05-20" }));
    const paid = await read();
    expect(paid.billing_status).toBe("paid");
    expect(Number(paid.difference)).toBe(-100);
    expect(Number(paid.unpaid_amount)).toBe(0);
  });
});
