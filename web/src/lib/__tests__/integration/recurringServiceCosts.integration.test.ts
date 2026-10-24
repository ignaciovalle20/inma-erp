/**
 * Recurring service costs and annual anniversary cycles (20261020010000,
 * 20261020020000) against the real inma-erp-dev project, as a signed-in
 * member (RLS on):
 *
 * 1. Annual cycles follow the start date's anniversary: advance mid-year
 *    (the "EBCO LA LIGUA - ANUAL" case: from 2026-07-01, due July 2026,
 *    never "1 de junio" of a year it had not started), arrears (due when
 *    the year ends), a domain, and an end date.
 * 2. Cost periods: monthly or on each anniversary, from max(start, January
 *    2026), never past the end date; editing the fixed cost moves the
 *    estimate of the open periods only.
 * 3. Purchase invoices -> cost periods: four equal invoices of a supplier
 *    for four services are allocated and confirmed (lib/costAllocationSuggestions.ts),
 *    the monthly result counts them as the services' cost and not as general
 *    costs, and the database refuses more than the net or a job on top.
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

import { suggestCostAllocations } from "@/lib/costAllocationSuggestionsLoader";
import { computeMonthlyResult } from "@/lib/reporting";

const tag = `TEST_RSCOST ${randomUUID().slice(0, 6)}`;
const db = serviceClient();
const ids = { company: "", user: "", client: "", supplier: "", otherSupplier: "" };
let member: SupabaseClient;

/** The company's month today (Chile), "YYYY-MM". */
const currentMonth = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Santiago", year: "numeric", month: "2-digit" })
  .format(new Date())
  .slice(0, 7);

function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let [year, month] = from.split("-").map(Number);
  while (`${year}-${String(month).padStart(2, "0")}` <= to) {
    out.push(`${year}-${String(month).padStart(2, "0")}-01`);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return out;
}

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
        currency: "CLP",
        reference_amount: 100_000,
        periodicity: "monthly",
        invoicing_mode: "advance",
        due_day: 1,
        status: "active",
        active: true,
        ...fields,
      })
      .select("id")
      .single(),
  );
  return row.id;
}

async function sinceStart(serviceId: string, until = "2026-10-01") {
  await ok(member.rpc("generate_recurring_service_occurrences_since_start", { p_service_id: serviceId, p_until: until }));
}

async function occurrencesOf(serviceId: string) {
  return ok<{ period: string; invoice_due_date: string | null; status: string }[]>(
    member
      .from("recurring_service_occurrences")
      .select("period, invoice_due_date, status")
      .eq("recurring_service_id", serviceId)
      .order("period"),
  );
}

async function costPeriodsOf(serviceId: string) {
  return ok<{ id: string; period: string; expected_amount: number }[]>(
    member
      .from("recurring_service_cost_periods")
      .select("id, period, expected_amount")
      .eq("recurring_service_id", serviceId)
      .order("period"),
  );
}

async function purchase(net: number, date: string, supplierId = ids.supplier): Promise<string> {
  const { data, error } = await member
    .rpc("create_cost_document", {
      p_company_id: ids.company,
      p_supplier_id: supplierId,
      p_project_id: null,
      p_classification: "general",
      p_document_date: date,
      p_currency: "CLP",
      p_tax_amount: Math.round(net * 0.19),
      p_lines: [{ description: `${tag} servicio`, amount: net }],
    })
    .select()
    .single<{ id: string }>();
  if (error || !data) throw new Error(JSON.stringify(error));
  return data.id;
}

beforeAll(async () => {
  assertDevProject();
  const company = await ok<{ id: string }>(
    db.from("companies").insert({ name: tag, country: "CL", currency: "CLP" }).select("id").single(),
  );
  ids.company = company.id;
  const email = `test_rscost_${randomUUID().slice(0, 6)}@example.test`;
  const password = randomBytes(24).toString("base64url");
  const { data: user, error } = await db.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  ids.user = user.user.id;
  await ok(db.from("company_memberships").insert({ user_id: ids.user, company_id: ids.company, role: "admin" }).select("id"));
  member = anonClient();
  const { error: signInError } = await member.auth.signInWithPassword({ email, password });
  if (signInError) throw signInError;
  memberClient = member;
  const client = await ok<{ id: string }>(member.from("clients").insert({ company_id: ids.company, name: tag }).select("id").single());
  ids.client = client.id;
  const supplier = await ok<{ id: string }>(
    member.from("suppliers").insert({ company_id: ids.company, name: `${tag} Starlink` }).select("id").single(),
  );
  ids.supplier = supplier.id;
  const other = await ok<{ id: string }>(
    member.from("suppliers").insert({ company_id: ids.company, name: `${tag} Otro`, active: false }).select("id").single(),
  );
  ids.otherSupplier = other.id;
}, 120_000);

afterAll(async () => {
  const failures: unknown[] = [];
  const step = async (p: PromiseLike<{ error: unknown }>) => {
    const { error } = await p;
    if (error) failures.push(error);
  };
  if (ids.company) {
    await step(db.from("cost_service_allocations").delete().eq("company_id", ids.company));
    await step(db.from("sales_allocations").delete().eq("company_id", ids.company));
    const services = ((await db.from("recurring_services").select("id").eq("company_id", ids.company)).data ?? []).map((r) => r.id);
    if (services.length) await step(db.from("recurring_service_occurrences").delete().in("recurring_service_id", services));
    await step(db.from("recurring_service_cost_periods").delete().eq("company_id", ids.company));
    await step(db.from("recurring_services").delete().eq("company_id", ids.company));
    const costDocs = ((await db.from("cost_documents").select("id").eq("company_id", ids.company)).data ?? []).map((r) => r.id);
    if (costDocs.length) await step(db.from("cost_lines").delete().in("cost_document_id", costDocs));
    await step(db.from("cost_documents").delete().eq("company_id", ids.company));
    const sales = ((await db.from("sales_documents").select("id").eq("company_id", ids.company)).data ?? []).map((r) => r.id);
    if (sales.length) await step(db.from("sales_lines").delete().in("sales_document_id", sales));
    await step(db.from("sales_documents").delete().eq("company_id", ids.company));
    await step(db.from("suppliers").delete().eq("company_id", ids.company));
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

describe("annual cycles by anniversary", () => {
  it("EBCO LA LIGUA - ANUAL: advance from 2026-07-01 gets its first cycle in July 2026, and a monthly cost every month", async () => {
    const ebco = await service({
      name: `${tag} EBCO LA LIGUA - ANUAL`,
      service_type: "starlink",
      periodicity: "annual",
      invoicing_mode: "advance",
      reference_amount: 1_200_000,
      start_date: "2026-07-01",
      end_date: "2027-06-01",
      fixed_cost: 50_000,
      cost_periodicity: "monthly",
      supplier_id: ids.supplier,
    });
    await sinceStart(ebco);

    const row = await ok<{ due_month: number }>(member.from("recurring_services").select("due_month").eq("id", ebco).single());
    expect(row.due_month).toBe(7);
    const cycles = await occurrencesOf(ebco);
    expect(cycles.map((c) => [c.period, c.invoice_due_date])).toEqual([["2026-07-01", "2026-07-01"]]);

    const costs = await costPeriodsOf(ebco);
    expect(costs.map((c) => c.period)).toEqual(monthsBetween("2026-07", currentMonth));
    expect(costs.every((c) => Number(c.expected_amount) === 50_000)).toBe(true);
  });

  it("arrears: the year is billed when it ends (start 2025-11-01 -> due October 2026)", async () => {
    const arrears = await service({
      name: `${tag} anual vencido`,
      service_type: "hosting",
      periodicity: "annual",
      invoicing_mode: "arrears",
      start_date: "2025-11-01",
    });
    await sinceStart(arrears, "2026-10-01");

    const row = await ok<{ due_month: number }>(member.from("recurring_services").select("due_month").eq("id", arrears).single());
    expect(row.due_month).toBe(10);
    const cycles = await occurrencesOf(arrears);
    expect(cycles.map((c) => [c.period, c.invoice_due_date?.slice(0, 7)])).toEqual([["2025-11-01", "2026-10"]]);
    // No fixed cost and no supplier: no cost periods.
    expect(await costPeriodsOf(arrears)).toEqual([]);
  });

  it("a domain: renewed on its anniversary, its yearly cost only in that month", async () => {
    const domain = await service({
      name: `${tag} dominio.cl`,
      service_type: "domain",
      periodicity: "annual",
      invoicing_mode: "advance",
      reference_amount: 30_000,
      start_date: "2025-03-15",
      fixed_cost: 12_000,
      cost_periodicity: "annual",
    });
    await sinceStart(domain);

    expect((await occurrencesOf(domain)).map((c) => c.period)).toEqual(["2026-03-01"]);
    const costs = await costPeriodsOf(domain);
    expect(costs.map((c) => [c.period, Number(c.expected_amount)])).toEqual([["2026-03-01", 12_000]]);
  });

  it("an end date stops both the cycles and the cost periods", async () => {
    const ended = await service({
      name: `${tag} hasta abril`,
      service_type: "server",
      start_date: "2026-01-01",
      end_date: "2026-04-30",
      fixed_cost: 1_000,
    });
    await sinceStart(ended);

    expect((await occurrencesOf(ended)).map((c) => c.period)).toEqual(monthsBetween("2026-01", "2026-04"));
    expect((await costPeriodsOf(ended)).map((c) => c.period)).toEqual(monthsBetween("2026-01", "2026-04"));
  });
});

describe("cost periods", () => {
  it("a new fixed cost moves the estimate of open periods only; an inactive supplier can't be chosen", async () => {
    const hosting = await service({
      name: `${tag} hosting editable`,
      service_type: "hosting",
      start_date: `${currentMonth}-01`,
      fixed_cost: 5_000,
    });
    const before = await costPeriodsOf(hosting);
    expect(before.map((c) => Number(c.expected_amount))).toEqual([5_000]);

    await ok(member.from("recurring_services").update({ fixed_cost: 6_000 }).eq("id", hosting).select("id"));
    expect((await costPeriodsOf(hosting)).map((c) => Number(c.expected_amount))).toEqual([6_000]);

    const { error } = await member.from("recurring_services").update({ supplier_id: ids.otherSupplier }).eq("id", hosting);
    expect(error?.message).toMatch(/inactivo/);
  });
});

describe("purchase invoices -> service cost periods", () => {
  it("four equal invoices of the supplier go to its four services, confirmed, and stop being general costs", async () => {
    const services = [];
    for (const n of [1, 2, 3, 4]) {
      services.push(
        await service({
          name: `${tag} Starlink ${n}`,
          service_type: "starlink",
          start_date: "2026-10-01",
          end_date: "2026-10-31",
          fixed_cost: 40_000,
          supplier_id: ids.supplier,
        }),
      );
    }
    const documents = [];
    for (const day of ["10", "10", "11", "12"]) documents.push(await purchase(40_000, `2026-10-${day}`));

    const result = await suggestCostAllocations(member as never, ids.company, { documentIds: documents });
    expect(result).toEqual({ confirmed: 4, suggested: 0, error: null });

    const allocations = await ok<{ cost_document_id: string; cost_period_id: string; status: string; amount: number }[]>(
      member.from("cost_service_allocations").select("cost_document_id, cost_period_id, status, amount").in("cost_document_id", documents),
    );
    expect(allocations).toHaveLength(4);
    expect(new Set(allocations.map((a) => a.cost_period_id)).size).toBe(4);
    expect(allocations.every((a) => a.status === "confirmed" && Number(a.amount) === 40_000)).toBe(true);
    for (const id of services) {
      const [period] = await costPeriodsOf(id);
      const summary = await ok<{ cost_status: string; invoiced_amount: number }>(
        member.from("recurring_service_cost_period_summary").select("cost_status, invoiced_amount").eq("cost_period_id", period.id).single(),
      );
      expect(summary).toEqual({ cost_status: "invoiced", invoiced_amount: 40_000 });
    }

    // Again: nothing new, nothing twice.
    expect(await suggestCostAllocations(member as never, ids.company, { documentIds: documents })).toEqual({
      confirmed: 0,
      suggested: 0,
      error: null,
    });

    // October: the four invoices are the Starlinks' cost, never also general
    // costs. The other October cost periods here: EBCO 50.000 (estimated)
    // and the editable hosting when this runs in October.
    const october = await computeMonthlyResult(ids.company, "2026-10-01");
    expect(october.hasError, JSON.stringify(october.errors)).toBe(false);
    expect(october.generalCostDocuments).toBe(0);
    const extra = currentMonth === "2026-10" ? 6_000 : 0;
    expect(october.recurringCosts).toBe(4 * 40_000 + 50_000 + extra);
  });

  it("refuses more than the net, and a job on top of a service allocation", async () => {
    const svc = await service({
      name: `${tag} Starlink extra`,
      service_type: "starlink",
      start_date: "2026-09-01",
      end_date: "2026-09-30",
      fixed_cost: 10_000,
      supplier_id: ids.supplier,
    });
    const [period] = await costPeriodsOf(svc);
    const doc = await purchase(10_000, "2026-09-05");

    const over = await member.rpc("set_cost_service_allocations", {
      p_cost_document_id: doc,
      p_allocations: [{ cost_period_id: period.id, amount: 10_001 }],
    });
    expect(over.error?.message).toMatch(/superan el neto/);

    await ok(
      member.rpc("set_cost_service_allocations", {
        p_cost_document_id: doc,
        p_allocations: [{ cost_period_id: period.id, amount: 10_000 }],
      }),
    );
    const { error } = await member.from("cost_documents").update({ classification: "direct" }).eq("id", doc);
    expect(error).not.toBeNull();
    const after = await ok<{ classification: string; service_allocated_amount: number }>(
      member.from("cost_documents").select("classification, service_allocated_amount").eq("id", doc).single(),
    );
    expect(after).toEqual({ classification: "general", service_allocated_amount: 10_000 });
  });
});

describe("Eliminar servicio (delete_recurring_service, 20261024010000)", () => {
  async function exists(table: string, column: string, value: string) {
    const { count } = await db.from(table).select("id", { count: "exact", head: true }).eq(column, value);
    return count ?? 0;
  }

  it("deletes a service with nothing assigned, with its cycles and cost periods", async () => {
    const svc = await service({
      name: `${tag} para borrar`,
      service_type: "starlink",
      start_date: "2026-08-01",
      end_date: "2026-10-31",
      fixed_cost: 2_000,
      supplier_id: ids.supplier,
    });
    await sinceStart(svc);
    expect((await occurrencesOf(svc)).length).toBe(3);
    expect((await costPeriodsOf(svc)).length).toBe(3);

    const result = await ok<{ cycles: number; cost_periods: number }>(member.rpc("delete_recurring_service", { p_service_id: svc }));
    expect(result).toMatchObject({ cycles: 3, cost_periods: 3 });
    expect(await exists("recurring_services", "id", svc)).toBe(0);
    expect(await exists("recurring_service_occurrences", "recurring_service_id", svc)).toBe(0);
    expect(await exists("recurring_service_cost_periods", "recurring_service_id", svc)).toBe(0);
  });

  it("refuses while a purchase or a sales invoice is assigned; once removed, deletes and leaves the invoices", async () => {
    const svc = await service({
      name: `${tag} con facturas`,
      service_type: "starlink",
      start_date: "2026-07-01",
      end_date: "2026-07-31",
      fixed_cost: 3_000,
      supplier_id: ids.supplier,
    });
    await sinceStart(svc);
    const [period] = await costPeriodsOf(svc);
    const purchaseDoc = await purchase(3_000, "2026-07-08");
    await ok(member.rpc("set_cost_service_allocations", { p_cost_document_id: purchaseDoc, p_allocations: [{ cost_period_id: period.id, amount: 3_000 }] }));

    const refusedCost = await member.rpc("delete_recurring_service", { p_service_id: svc });
    expect(refusedCost.error?.message).toMatch(/1 de facturas de compra/);

    await ok(member.rpc("set_cost_service_allocations", { p_cost_document_id: purchaseDoc, p_allocations: [] }));
    const cycle = await ok<{ id: string }>(
      member.from("recurring_service_occurrences").select("id").eq("recurring_service_id", svc).single(),
    );
    const sale = await ok<{ id: string }>(
      db
        .from("sales_documents")
        .insert({
          company_id: ids.company,
          client_id: ids.client,
          document_type: "invoice",
          document_number: `DEL-${tag}`,
          document_date: "2026-07-05",
          currency: "CLP",
          net_amount: 100_000,
          tax_amount: 0,
          total_amount: 100_000,
          source: "import",
          payment_status: "impago",
        })
        .select("id")
        .single(),
    );
    await ok(
      member
        .from("sales_allocations")
        .insert({ company_id: ids.company, sales_document_id: sale.id, recurring_service_period_id: cycle.id, amount: 100_000, status: "confirmed" })
        .select("id"),
    );

    const refusedSale = await member.rpc("delete_recurring_service", { p_service_id: svc });
    expect(refusedSale.error?.message).toMatch(/1 de ventas/);
    expect(await exists("recurring_services", "id", svc)).toBe(1);

    await ok(member.from("sales_allocations").delete().eq("sales_document_id", sale.id).select("id"));
    await ok(member.rpc("delete_recurring_service", { p_service_id: svc }));
    expect(await exists("recurring_services", "id", svc)).toBe(0);
    expect(await exists("sales_documents", "id", sale.id)).toBe(1);
    expect(await exists("cost_documents", "id", purchaseDoc)).toBe(1);
  });

  it("someone who is not a member cannot delete", async () => {
    const svc = await service({ name: `${tag} ajeno`, service_type: "hosting", start_date: "2026-10-01" });
    const { error } = await anonClient().rpc("delete_recurring_service", { p_service_id: svc });
    expect(error).not.toBeNull();
    expect(await exists("recurring_services", "id", svc)).toBe(1);
  });
});
