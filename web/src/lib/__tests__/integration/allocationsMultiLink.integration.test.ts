/**
 * Against the real inma-erp-dev project, as a signed-in member (RLS on):
 *
 * 1. The automatic suggestions (lib/allocationSuggestionsLoader.ts): the
 *    only period of the month whatever the amount, a proportional split
 *    adding up exactly to the net, the one quote with balance, nothing when
 *    no rule applies -- and never twice for the same documents.
 * 2. An invoice spread over two periods, a period billed with two invoices
 *    (one paid), and an invoice spread over two jobs: Deuda, the
 *    profitability report, the sales list's job filter and the jobs'
 *    billing balances show each one's share, never the whole document on
 *    the single link sales_documents.project_id /
 *    recurring_service_occurrences.sales_document_id can hold.
 *
 * Run with `npm run test:integration`.
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

const tag = `TEST_MULTI ${randomUUID().slice(0, 6)}`;
const db = serviceClient();
const ids = { company: "", user: "", area: "", clients: {} as Record<string, string> };
let member: SupabaseClient;

async function ok<T = unknown>(p: PromiseLike<{ data: unknown; error: unknown }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(JSON.stringify(error));
  return data as T;
}

async function service(client: string, name: string, reference: number, extra: Record<string, unknown> = {}) {
  const row = await ok<{ id: string }>(
    member
      .from("recurring_services")
      .insert({
        company_id: ids.company,
        client_id: ids.clients[client],
        name: `${tag} ${name}`,
        reference_amount: reference,
        expected_cost: 0,
        currency: "CLP",
        periodicity: "monthly",
        invoicing_mode: "advance",
        start_date: "2026-10-01",
        end_date: "2026-10-31",
        status: "active",
        active: true,
        ...extra,
      })
      .select("id")
      .single(),
  );
  return row.id;
}

async function octoberPeriod(serviceId: string) {
  return ok<{ id: string }>(
    member
      .from("recurring_service_occurrences")
      .select("id")
      .eq("recurring_service_id", serviceId)
      .eq("period", "2026-10-01")
      .single(),
  );
}

async function invoice(client: string, number: string, net: number, date = "2026-10-05", paid = false) {
  const row = await ok<{ id: string }>(
    db
      .from("sales_documents")
      .insert({
        company_id: ids.company,
        client_id: ids.clients[client],
        document_type: "invoice",
        document_number: `${number}-${tag}`,
        document_date: date,
        currency: "CLP",
        net_amount: net,
        tax_amount: 0,
        total_amount: net,
        source: "import",
        payment_status: paid ? "pagado" : "impago",
        paid_at: paid ? date : null,
      })
      .select("id")
      .single(),
  );
  return row.id;
}

async function job(client: string, name: string, quoted: number) {
  const { data, error } = await member.rpc("create_project_with_quote", {
    p_company_id: ids.company,
    p_client_id: ids.clients[client],
    p_business_area_id: ids.area,
    p_name: `${tag} ${name}`,
    p_status: "en_ejecucion",
    p_quote_number: `COT-${name}-${tag}`,
    p_start_date: "2026-10-01",
    p_end_date: null,
    p_quoted_amount: quoted,
    p_cost_budget: null,
    p_responsible: null,
    p_invoiceable: true,
  });
  if (error) throw new Error(error.message);
  const projectId = (data as { id: string }).id;
  const quote = await ok<{ id: string }>(
    member.from("project_quotes").select("id").eq("project_id", projectId).single(),
  );
  return { projectId, quoteId: quote.id };
}

async function allocationsOf(documentId: string) {
  return ok<{ recurring_service_period_id: string | null; project_quote_id: string | null; amount: number; status: string; suggestion_reason: string | null }[]>(
    member
      .from("sales_allocations")
      .select("recurring_service_period_id, project_quote_id, amount, status, suggestion_reason")
      .eq("sales_document_id", documentId)
      .order("amount"),
  );
}

beforeAll(async () => {
  assertDevProject();
  const company = await ok<{ id: string }>(
    db.from("companies").insert({ name: tag, country: "CL", currency: "CLP" }).select("id").single(),
  );
  ids.company = company.id;
  const email = `test_multi_${randomUUID().slice(0, 6)}@example.test`;
  const password = randomBytes(24).toString("base64url");
  const { data: user, error } = await db.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  ids.user = user.user.id;
  await ok(db.from("company_memberships").insert({ user_id: ids.user, company_id: ids.company, role: "admin" }).select("id"));
  member = anonClient();
  const { error: signInError } = await member.auth.signInWithPassword({ email, password });
  if (signInError) throw signInError;
  memberClient = member;
  for (const key of ["single", "split", "quote", "periods", "jobs"]) {
    const client = await ok<{ id: string }>(
      member.from("clients").insert({ company_id: ids.company, name: `${tag} ${key}` }).select("id").single(),
    );
    ids.clients[key] = client.id;
  }
  const area = await ok<{ id: string }[]>(member.from("business_areas").select("id").eq("company_id", ids.company).limit(1));
  ids.area = area[0].id;
}, 120_000);

afterAll(async () => {
  memberClient = null;
  const failures: unknown[] = [];
  const step = async (p: PromiseLike<{ error: unknown }>) => {
    const { error } = await p;
    if (error) failures.push(error);
  };
  if (ids.company) {
    await step(db.from("sales_allocations").delete().eq("company_id", ids.company));
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

describe("automatic suggestions", () => {
  const docs: Record<string, string> = {};
  const periods: Record<string, string> = {};
  let quoteId = "";

  beforeAll(async () => {
    const single = await service("single", "licencias", 10_000);
    const hosting = await service("split", "hosting", 9_000, { service_type: "hosting" });
    const extra = await service("split", "extra", 1_000);
    // As opening the module does.
    await ok(member.rpc("ensure_recurring_service_periods", { p_company_id: ids.company, p_until: "2026-10-01" }));
    periods.single = (await octoberPeriod(single)).id;
    periods.hosting = (await octoberPeriod(hosting)).id;
    periods.extra = (await octoberPeriod(extra)).id;
    quoteId = (await job("quote", "obra", 50_000)).quoteId;

    docs.single = await invoice("single", "S1", 11_200);
    docs.split = await invoice("split", "S2", 10_500);
    docs.quote = await invoice("quote", "S3", 20_000);
    docs.none = await invoice("quote", "S4", 40_000, "2026-10-20");
  }, 120_000);

  it("applies each rule once, in date order, and never twice", async () => {
    const { suggestAllocations } = await import("@/lib/allocationSuggestionsLoader");

    const first = await suggestAllocations(member as never, ids.company, Object.values(docs));
    expect(first).toEqual({ created: 3, error: null });

    expect(await allocationsOf(docs.single)).toEqual([
      { recurring_service_period_id: periods.single, project_quote_id: null, amount: 11_200, status: "suggested", suggestion_reason: "single_period" },
    ]);
    const split = await allocationsOf(docs.split);
    expect(split.map((row) => [row.recurring_service_period_id, Number(row.amount), row.suggestion_reason])).toEqual([
      [periods.extra, 1_050, "proportional"],
      [periods.hosting, 9_450, "proportional"],
    ]);
    expect(await allocationsOf(docs.quote)).toMatchObject([
      { project_quote_id: quoteId, amount: 20_000, suggestion_reason: "quote" },
    ]);
    // What is left of the quote (30.000) cannot take 40.000; the month has no period.
    expect(await allocationsOf(docs.none)).toEqual([]);

    const again = await suggestAllocations(member as never, ids.company, Object.values(docs));
    expect(again.created).toBe(0);
    expect((await allocationsOf(docs.split)).length).toBe(2);

    // Suggestions do not bill the period until confirmed.
    const period = await ok<{ status: string }>(
      member.from("recurring_service_occurrences").select("status").eq("id", periods.single).single(),
    );
    expect(period.status).toBe("pending_invoice");
  });
});

describe("one invoice, several destinations", () => {
  const periods: Record<string, string> = {};
  const jobs: Record<string, { projectId: string; quoteId: string }> = {};
  const docs: Record<string, string> = {};

  beforeAll(async () => {
    const a = await service("periods", "A", 6_000);
    const b = await service("periods", "B", 4_000);
    const c = await service("periods", "C", 5_000);
    await ok(member.rpc("ensure_recurring_service_periods", { p_company_id: ids.company, p_until: "2026-10-01" }));
    periods.a = (await octoberPeriod(a)).id;
    periods.b = (await octoberPeriod(b)).id;
    periods.c = (await octoberPeriod(c)).id;

    // One invoice for A + B.
    docs.ab = await invoice("periods", "M1", 10_000, "2026-10-06");
    await ok(
      member.rpc("set_sales_allocations", {
        p_sales_document_id: docs.ab,
        p_allocations: [
          { target_type: "period", target_id: periods.a, amount: 6_000, status: "confirmed" },
          { target_type: "period", target_id: periods.b, amount: 4_000, status: "confirmed" },
        ],
      }),
    );
    // C billed with two invoices, the first one paid.
    docs.c1 = await invoice("periods", "N1", 3_000, "2026-10-07", true);
    docs.c2 = await invoice("periods", "N2", 2_000, "2026-10-08");
    for (const [doc, amount] of [[docs.c1, 3_000], [docs.c2, 2_000]] as const) {
      await ok(
        member.rpc("set_sales_allocations", {
          p_sales_document_id: doc,
          p_allocations: [{ target_type: "period", target_id: periods.c, amount, status: "confirmed" }],
        }),
      );
    }

    // One invoice for two jobs.
    jobs.one = await job("jobs", "uno", 10_000);
    jobs.two = await job("jobs", "dos", 10_000);
    docs.jobs = await invoice("jobs", "T1", 10_000, "2026-10-09");
    await ok(
      member.rpc("set_sales_allocations", {
        p_sales_document_id: docs.jobs,
        p_allocations: [
          { target_type: "quote", target_id: jobs.one.quoteId, amount: 7_000, status: "confirmed" },
          { target_type: "quote", target_id: jobs.two.quoteId, amount: 3_000, status: "confirmed" },
        ],
      }),
    );
  }, 120_000);

  it("Deuda owes each period its unpaid share", async () => {
    const { getPendingRecurringServiceOccurrences } = await import("@/lib/dal");
    const { cycleMoney, debtByClient } = await import("@/lib/recurringServicePending");

    const pending = (await getPendingRecurringServiceOccurrences(ids.company)).filter(
      (row) => row.client_id === ids.clients.periods,
    );
    const owed = Object.fromEntries(pending.map((row) => [row.id, cycleMoney(row)]));
    expect(owed).toEqual({ [periods.a]: 6_000, [periods.b]: 4_000, [periods.c]: 2_000 });

    const [client] = debtByClient(pending);
    expect(client.totals).toEqual([{ currency: "CLP", amount: 12_000 }]);
  });

  it("the report puts each job's share on that job, and counts the invoices once", async () => {
    const { getProfitabilityBreakdown } = await import("@/lib/reporting");
    const breakdown = await getProfitabilityBreakdown(ids.company, "2026-10-01");
    const project = (id: string) => breakdown.projects.find((row) => row.id === id)!;
    const client = (key: string) => breakdown.clients.find((row) => row.id === ids.clients[key])!;

    expect(project(jobs.one.projectId)).toMatchObject({ revenue: 7_000, accumulatedRevenue: 7_000 });
    expect(project(jobs.two.projectId)).toMatchObject({ revenue: 3_000, accumulatedRevenue: 3_000 });
    // The invoices of A + B and of C (10.000 + 3.000 + 2.000), not the cycles again.
    expect(client("periods").revenue).toBe(15_000);
    expect(client("jobs").revenue).toBe(10_000);
  });

  it("the sales list filtered by a job shows the invoice with that job's part", async () => {
    const { getSalesListRows, getProjectBillingBalances } = await import("@/lib/dal");
    const rows = await getSalesListRows(ids.company, { projectId: jobs.two.projectId, excludeVoided: true });
    expect(rows.map((row) => [row.id, row.attributed_net])).toEqual([[docs.jobs, 3_000]]);

    const balances = await getProjectBillingBalances(ids.company);
    const invoiced = (projectId: string) => balances.find((row) => row.projectId === projectId)?.invoicedAmount;
    expect(invoiced(jobs.one.projectId)).toBe(7_000);
    expect(invoiced(jobs.two.projectId)).toBe(3_000);
  });
});
