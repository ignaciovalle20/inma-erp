/**
 * Invoice allocations (20261016010000) against the real inma-erp-dev
 * project, as a company member (RLS on): automatic suggestion by net
 * amount (never twice), confirming moves the period, the invoice's payment
 * moves it to paid, the total never exceeds the net, a job link becomes a
 * quote allocation, per-unit periods follow their quantity and the MS pool
 * splits by what was billed. Run with `npm run test:integration`.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { anonClient, assertDevProject, serviceClient } from "./devProject";

const tag = `TEST_ALLOC ${randomUUID().slice(0, 6)}`;
const db = serviceClient();
const ids = { company: "", user: "", client: "", area: "" };
let member: SupabaseClient;

async function ok<T = unknown>(p: PromiseLike<{ data: unknown; error: unknown }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(JSON.stringify(error));
  return data as T;
}

async function service(fields: Record<string, unknown>): Promise<string> {
  const row = await ok<{ id: string }>(
    member
      .from("recurring_services")
      .insert({
        company_id: ids.company,
        client_id: ids.client,
        expected_cost: 0,
        currency: "CLP",
        periodicity: "monthly",
        invoicing_mode: "advance",
        start_date: "2026-09-01",
        status: "active",
        active: true,
        ...fields,
      })
      .select("id")
      .single(),
  );
  return row.id;
}

async function periodOf(serviceId: string, period: string) {
  return ok<{ id: string; amount: number; quantity: number | null; status: string; sales_document_id: string | null }>(
    member
      .from("recurring_service_occurrences")
      .select("id, amount, quantity, status, sales_document_id")
      .eq("recurring_service_id", serviceId)
      .eq("period", period)
      .single(),
  );
}

async function invoice(fields: { net: number; date: string; number: string; projectId?: string | null }) {
  const row = await ok<{ id: string }>(
    db
      .from("sales_documents")
      .insert({
        company_id: ids.company,
        client_id: ids.client,
        project_id: fields.projectId ?? null,
        document_type: "invoice",
        document_number: `${fields.number}-${tag}`,
        document_date: fields.date,
        currency: "CLP",
        net_amount: fields.net,
        tax_amount: 0,
        total_amount: fields.net,
        source: "import",
        payment_status: "impago",
      })
      .select("id")
      .single(),
  );
  return row.id;
}

beforeAll(async () => {
  assertDevProject();
  const company = await ok<{ id: string }>(
    db.from("companies").insert({ name: tag, country: "CL", currency: "CLP" }).select("id").single(),
  );
  ids.company = company.id;
  const email = `test_alloc_${randomUUID().slice(0, 6)}@example.test`;
  const password = randomBytes(24).toString("base64url");
  const { data: user, error } = await db.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  ids.user = user.user.id;
  await ok(db.from("company_memberships").insert({ user_id: ids.user, company_id: ids.company, role: "admin" }).select("id"));
  member = anonClient();
  const { error: signInError } = await member.auth.signInWithPassword({ email, password });
  if (signInError) throw signInError;
  const client = await ok<{ id: string }>(member.from("clients").insert({ company_id: ids.company, name: tag }).select("id").single());
  ids.client = client.id;
  const area = await ok<{ id: string }[]>(member.from("business_areas").select("id").eq("company_id", ids.company).limit(1));
  ids.area = area[0]?.id ?? "";
}, 120_000);

afterAll(async () => {
  const failures: unknown[] = [];
  const step = async (p: PromiseLike<{ error: unknown }>) => {
    const { error } = await p;
    if (error) failures.push(error);
  };
  if (ids.company) {
    await step(db.from("sales_allocations").delete().eq("company_id", ids.company));
    const pools = ((await db.from("recurring_service_cost_pools").select("id").eq("company_id", ids.company)).data ?? []).map((r) => r.id);
    if (pools.length) await step(db.from("recurring_service_cost_allocations").delete().in("cost_pool_id", pools));
    await step(db.from("recurring_service_cost_pools").delete().eq("company_id", ids.company));
    const services = ((await db.from("recurring_services").select("id").eq("company_id", ids.company)).data ?? []).map((r) => r.id);
    if (services.length) await step(db.from("recurring_service_occurrences").delete().in("recurring_service_id", services));
    await step(db.from("recurring_services").delete().eq("company_id", ids.company));
    const sales = ((await db.from("sales_documents").select("id").eq("company_id", ids.company)).data ?? []).map((r) => r.id);
    if (sales.length) await step(db.from("sales_lines").delete().in("sales_document_id", sales));
    await step(db.from("sales_documents").delete().eq("company_id", ids.company));
    const projects = ((await db.from("projects").select("id").eq("company_id", ids.company)).data ?? []).map((r) => r.id);
    if (projects.length) {
      await step(db.from("project_notes").delete().in("project_id", projects));
      await step(db.from("project_checklist_items").delete().in("project_id", projects));
    }
    await step(db.from("project_quotes").delete().eq("company_id", ids.company));
    await step(db.from("projects").delete().eq("company_id", ids.company));
    await step(db.from("company_memberships").delete().eq("company_id", ids.company));
    await step(db.from("clients").delete().eq("company_id", ids.company));
    await step(db.from("business_areas").delete().eq("company_id", ids.company));
    await step(db.from("companies").delete().eq("id", ids.company));
  }
  if (ids.user) {
    const { error } = await db.auth.admin.deleteUser(ids.user);
    if (error) failures.push(error);
  }
  if (failures.length) throw new Error(`cleanup failed (${tag}): ${JSON.stringify(failures)}`);
}, 120_000);

describe("sales allocations", () => {
  it("suggests one destination by net amount, never twice; confirming and paying move the period", async () => {
    const hosting = await service({ name: `${tag} hosting`, reference_amount: 10_000, service_type: "hosting" });
    await ok(member.rpc("ensure_recurring_service_periods", { p_company_id: ids.company, p_until: "2026-10-01" }));
    const october = await periodOf(hosting, "2026-10-01");
    expect(Number(october.amount)).toBe(10_000);

    const doc = await invoice({ net: 10_000, date: "2026-10-03", number: "A1" });
    const first = await ok<{ recurring_service_period_id: string }[]>(
      member.rpc("suggest_sales_allocations", { p_company_id: ids.company, p_sales_document_ids: [doc] }),
    );
    expect(first).toHaveLength(1);
    expect(first[0].recurring_service_period_id).toBe(october.id);
    const again = await ok<unknown[]>(
      member.rpc("suggest_sales_allocations", { p_company_id: ids.company, p_sales_document_ids: [doc] }),
    );
    expect(again).toHaveLength(0);

    // A suggestion does not bill the period yet.
    expect((await periodOf(hosting, "2026-10-01")).status).toBe("pending_invoice");

    await ok(member.from("sales_allocations").update({ status: "confirmed" }).eq("sales_document_id", doc).select("id"));
    const invoiced = await periodOf(hosting, "2026-10-01");
    expect(invoiced).toMatchObject({ status: "invoiced", sales_document_id: doc });

    await ok(member.rpc("set_sales_documents_payment_status", { p_sales_document_ids: [doc], p_payment_status: "pagado", p_paid_at: "2026-10-10" }));
    const summary = await ok<{ billing_status: string; billed_amount: number; difference: number }>(
      member.from("recurring_service_period_summary").select("billing_status, billed_amount, difference").eq("recurring_service_period_id", october.id).single(),
    );
    expect(summary).toMatchObject({ billing_status: "paid" });
    expect(Number(summary.billed_amount)).toBe(10_000);
    expect(Number(summary.difference)).toBe(0);
  });

  it("never allocates more than the document's net", async () => {
    const svc = await service({ name: `${tag} cloud`, reference_amount: 5_000, service_type: "server" });
    await ok(member.rpc("ensure_recurring_service_periods", { p_company_id: ids.company, p_until: "2026-10-01" }));
    const october = await periodOf(svc, "2026-10-01");
    const doc = await invoice({ net: 4_000, date: "2026-10-04", number: "A2" });
    const { error } = await member.rpc("set_sales_allocations", {
      p_sales_document_id: doc,
      p_allocations: [{ target_type: "period", target_id: october.id, amount: 4_500, status: "confirmed" }],
    });
    expect(error?.message).toMatch(/exceed/);

    await ok(
      member.rpc("set_sales_allocations", {
        p_sales_document_id: doc,
        p_allocations: [{ target_type: "period", target_id: october.id, amount: 3_000, status: "confirmed" }],
      }),
    );
    const left = await ok<{ unallocated_amount: number }>(
      member.from("sales_document_allocation_summary").select("unallocated_amount").eq("sales_document_id", doc).single(),
    );
    expect(Number(left.unallocated_amount)).toBe(1_000);
  });

  it("a document linked to a job gets a quote allocation; billed vs. quoted follows", async () => {
    const { data: project, error } = await member.rpc("create_project_with_quote", {
      p_company_id: ids.company,
      p_client_id: ids.client,
      p_business_area_id: ids.area,
      p_name: `${tag} trabajo`,
      p_status: "en_ejecucion",
      p_quote_number: `COT-${tag}`,
      p_start_date: "2026-10-01",
      p_end_date: null,
      p_quoted_amount: 50_000,
      p_cost_budget: null,
      p_responsible: null,
      p_invoiceable: true,
    });
    if (error) throw new Error(error.message);
    const projectId = (project as { id: string }).id;

    const doc = await invoice({ net: 20_000, date: "2026-10-05", number: "A3", projectId });
    const allocations = await ok<{ project_quote_id: string; amount: number; status: string }[]>(
      member.from("sales_allocations").select("project_quote_id, amount, status").eq("sales_document_id", doc),
    );
    expect(allocations).toHaveLength(1);
    expect(allocations[0]).toMatchObject({ status: "confirmed" });
    expect(Number(allocations[0].amount)).toBe(20_000);

    const billing = await ok<{ quoted_amount: number; billed_amount: number; billed_pct: number }>(
      member.from("project_quote_billing_summary").select("quoted_amount, billed_amount, billed_pct").eq("project_id", projectId).single(),
    );
    expect(Number(billing.quoted_amount)).toBe(50_000);
    expect(Number(billing.billed_amount)).toBe(20_000);
    expect(Number(billing.billed_pct)).toBe(40);

    // A second invoice for the open balance is suggested to the quote.
    const rest = await invoice({ net: 30_000, date: "2026-10-20", number: "A4" });
    const suggested = await ok<{ project_quote_id: string }[]>(
      member.rpc("suggest_sales_allocations", { p_company_id: ids.company, p_sales_document_ids: [rest] }),
    );
    expect(suggested).toHaveLength(1);
    expect(suggested[0].project_quote_id).toBe(allocations[0].project_quote_id);
  });

  it("per unit: the reference is price x quantity and a period follows its own quantity", async () => {
    const svc = await service({
      name: `${tag} licencias`,
      service_type: "ms_licenses",
      pricing_mode: "per_unit",
      unit_price: 1_500,
      default_quantity: 4,
      // Out of November, where the pool test below splits the licenses.
      end_date: "2026-10-31",
    });
    const stored = await ok<{ reference_amount: number }>(member.from("recurring_services").select("reference_amount").eq("id", svc).single());
    expect(Number(stored.reference_amount)).toBe(6_000);

    await ok(member.rpc("ensure_recurring_service_periods", { p_company_id: ids.company, p_until: "2026-10-01" }));
    const october = await periodOf(svc, "2026-10-01");
    expect(Number(october.quantity)).toBe(4);
    expect(Number(october.amount)).toBe(6_000);

    await ok(member.from("recurring_service_occurrences").update({ quantity: 6 }).eq("id", october.id).select("id"));
    expect(Number((await periodOf(svc, "2026-10-01")).amount)).toBe(9_000);
  });

  it("the MS pool splits by what each period billed (expected while unbilled)", async () => {
    const a = await service({ name: `${tag} ms a`, reference_amount: 1_000, service_type: "ms_licenses", uses_cost_pool: true, start_date: "2026-11-01" });
    const b = await service({ name: `${tag} ms b`, reference_amount: 1_000, service_type: "ms_licenses", uses_cost_pool: true, start_date: "2026-11-01" });
    await ok(member.rpc("ensure_recurring_service_periods", { p_company_id: ids.company, p_until: "2026-11-01" }));
    const pa = await periodOf(a, "2026-11-01");
    const doc = await invoice({ net: 3_000, date: "2026-11-02", number: "A5" });
    await ok(
      member.rpc("set_sales_allocations", {
        p_sales_document_id: doc,
        p_allocations: [{ target_type: "period", target_id: pa.id, amount: 3_000, status: "confirmed" }],
      }),
    );
    // The licenses periods of the other tests (October) are in another period.
    const pool = await ok<{ id: string }>(
      member
        .from("recurring_service_cost_pools")
        .insert({ company_id: ids.company, service_type: "ms_licenses", period: "2026-11-01", total_expense_amount: 400, currency: "CLP" })
        .select("id")
        .single(),
    );
    const rows = await ok<{ occurrence_id: string; allocated_amount: number }[]>(
      member.rpc("allocate_recurring_service_cost_pool", { p_cost_pool_id: pool.id }),
    );
    const pb = await periodOf(b, "2026-11-01");
    const share = (id: string) => Number(rows.find((row) => row.occurrence_id === id)?.allocated_amount);
    expect(share(pa.id)).toBe(300);
    expect(share(pb.id)).toBe(100);
  });
});
