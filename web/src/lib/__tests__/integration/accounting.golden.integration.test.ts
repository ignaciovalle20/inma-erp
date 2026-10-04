/**
 * Accounting golden dataset (docs/verificacion-contable-2026-10-04.md).
 *
 * Builds two throwaway companies (Chile CLP, Uruguay USD with UYU documents)
 * in inma-erp-dev with every kind of document the reports add up, then
 * checks each report against figures worked out BY HAND below -- constants,
 * never recomputed with the system's own logic. Everything runs as real
 * signed-in members (RLS applies) and every row created here is deleted in
 * afterAll, including the exchange-rate snapshots (a global table), which
 * use 1998 periods nobody else has.
 *
 * Run with `npm run test:integration`.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
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

import {
  computeConsolidatedResult,
  computeMonthlyResult,
  computeProjectProfitability,
  getMonthlySeries,
  getProfitabilityBreakdown,
} from "@/lib/reporting";
import { getProjectBillingBalances, getRecurringServiceOccurrencesForMonth, getSalesPending } from "@/lib/dal";
import { analyzeNuboxRows } from "@/app/companies/[id]/sales/import/nubox/analysis";
import { commitNuboxImport } from "@/app/companies/[id]/sales/import/nubox/actions";
import { getTechnicianCharges } from "@/lib/technicianDal";
import { summarizeByTechnician } from "@/lib/technicians";
import { isOverdue, totalsByCurrency } from "@/lib/recurringServicePending";
import { totalWithVat } from "@/lib/vat";

const PREFIX = "TEST_ACCT_";
const tag = randomUUID().slice(0, 6);
const OUT = process.env.ACCT_OUT;
const report: Record<string, unknown> = { tag };

// Main period and its neighbours. 1998 so nothing real is ever in range;
// the FX snapshots for these months are created and deleted here.
const P = "1998-03-01";
const FEB = "1998-02-01";
const FX = [
  // USD per CLP = 1/1000, USD per UYU = 25/1000 = 0.025 (40 UYU = 1 USD).
  { currency: "CLP", period: FEB, ars_per_unit: 1, ars_per_usd: 1000 },
  { currency: "CLP", period: P, ars_per_unit: 1, ars_per_usd: 1000 },
  { currency: "UYU", period: FEB, ars_per_unit: 25, ars_per_usd: 1000 },
  { currency: "UYU", period: P, ars_per_unit: 25, ars_per_usd: 1000 },
];

// ---------------------------------------------------------------------
// The oracle: every expected figure, worked out by hand.
// ---------------------------------------------------------------------
//
// CHILE (CLP, IVA 19%) -- March 1998
//  Sales documents (net):
//   S1 invoice F1 C1/J1 1.000.000 (pagado)     S2 invoice F2 C1/J1 300.000 (por vencer)
//   S3 credit note NC1 C1/J1 300.000 annuls S2 S4 manual J2 400.000 on 31-03 (pagado)
//   S5 manual J2 100.000 (se debe)             S7 invoice F3 C2, area M365, 2.000 (Nubox
//      match of the MS-b cycle)
//   S6 credit note NC2 C1/J1 50.000, NOT paired (a discount): subtracts.
//   (A paired credit note voids itself and its invoice: S2 + S3 count 0.)
//   Out of March: 28-02 invoice C2 70.000 (Feb) and 01-04 invoice C2 50.000 (Apr).
//   Documents total = 1.000.000 - 50.000 + 400.000 + 100.000 + 2.000 = 1.452.000
//  Recurring cycles recognised in March (invoiced/collected, no sales document):
//   MS-a C1 1.000, MS-c C3 1.000 (collected), MS-z C3 0 (venta 0), Hosting annual C1
//   120.000, Starlink arrears (Feb service) C2 50.000. MS-b is counted through S7.
//   MS-v (void) and Cloud (pending_collection, no invoice) are not revenue.
//   Recurring revenue = 172.000
//  NET SALES = 1.624.000
//  Direct cost documents: K1 J1 200.000 + technician charge J1 100.000 net = 300.000
//  Recurring costs: MS pool 1.000 (split 333/333/334 over a, b, c; z 0; void none)
//   + Hosting 2.000/month x 12 = 24.000 + Starlink 30.000 = 55.000
//  DIRECT COSTS = 355.000 ; DIRECT MARGIN = 1.269.000
//  General: K2 Starlink fixed 80.000 (unassigned) + K3 servers 120.000 (50% C2 / 50%
//   area Hosting) + payroll 300.000 (90.000 to J1, 60.000 to J2) = 500.000
//  OPERATING RESULT = 769.000
const CL = {
  netSales: 1_624_000,
  directCosts: 355_000,
  directMargin: 1_269_000,
  generalCosts: 500_000,
  operatingResult: 769_000,
  febNetSales: 70_000,
  projects: {
    J1: { revenue: 950_000, costs: 390_000, margin: 560_000 },
    J2: { revenue: 500_000, costs: 60_000, margin: 440_000 },
  },
  // Pool shares are 333/333/334 in some order: client totals are checked
  // with the pool part separately.
  clients: {
    C1: { revenue: 1_071_000, costsWithoutPool: 414_000 }, // 300k + 90k labour + 24k hosting
    C2: { revenue: 552_000, costsWithoutPool: 150_000 }, // 60k labour + 60k K3 + 30k starlink
    C3: { revenue: 1_000, costsWithoutPool: 0 },
  },
  poolTotal: 1_000,
  areas: {
    Development: { revenue: 950_000, costs: 390_000 },
    Networking: { revenue: 500_000, costs: 60_000 },
    "Microsoft 365": { revenue: 4_000, costs: 1_000 },
    Hosting: { revenue: 120_000, costs: 84_000 },
    Starlink: { revenue: 50_000, costs: 30_000 },
    Cloud: { revenue: 0, costs: 0 },
  },
  // What no client/area carries: K2 80.000 + the other half of K3 60.000 +
  // the payroll not imputed to a job 150.000.
  unassignedClientCosts: 290_000,
  unassignedAreaCosts: 290_000,
  technicianBalance: 69_000, // charged 119.000 (IVA incl.) - paid 50.000
  // Cobros (gross, what the client pays): invoiced 1.190.000 + 476.000 + 100.000 + 2.380
  billedGross: 1_768_380,
  collectedGross: 1_666_000,
  pendingGross: 102_380,
};

// URUGUAY (company currency USD, IVA 22%) -- March 1998, 40 UYU = 1 USD
//  Sales: SU1 USD 2.000 (JU1) + SU2 UYU 40.000 = USD 1.000 (U2, area IT Support)
//   + SU3 manual USD 500 (JU1) = 3.500
//  Recurring: Hosting U1 USD 100 + MS U2 UYU 4.000 = USD 100 -> 200
//  NET SALES = 3.700
//  Direct: KU1 USD 800 (JU1) + recurring costs Hosting 30 + MS pool UYU 2.000 = USD 50
//   -> 880 ; General: KU2 UYU 20.000 = USD 500 (unassigned)
//  OPERATING RESULT = 3.700 - 880 - 500 = 2.320
const UY = {
  netSales: 3_700,
  directCosts: 880,
  generalCosts: 500,
  operatingResult: 2_320,
  clients: { U1: { revenue: 2_600, costs: 830 }, U2: { revenue: 1_100, costs: 50 } },
  areas: {
    Development: { revenue: 2_500, costs: 800 },
    "IT Support": { revenue: 1_000, costs: 0 },
    Hosting: { revenue: 100, costs: 30 },
    "Microsoft 365": { revenue: 100, costs: 50 },
  },
  unassigned: 500,
};

// CONSOLIDATED (USD): Chile 769.000 CLP / 1000 = 769 + Uruguay 2.320 = 3.089
const CONSOLIDATED_USD = 3_089;

// ---------------------------------------------------------------------

const db = serviceClient();
const ids = {
  companies: [] as string[],
  users: [] as string[],
  cl: "",
  uy: "",
  empty: "",
  area: {} as Record<string, Record<string, string>>,
  client: {} as Record<string, string>,
  project: {} as Record<string, string>,
  occurrence: {} as Record<string, string>,
  personnel: {} as Record<string, string>,
};
let memberA: SupabaseClient; // member of CL, UY and EMPTY
let memberB: SupabaseClient; // member of CL only

async function ok(p: PromiseLike<{ data: unknown; error: unknown }>, what: string): Promise<unknown> {
  const { data, error } = await p;
  if (error) throw new Error(`${what}: ${JSON.stringify(error)}`);
  return data;
}

async function signIn(email: string) {
  const password = randomBytes(24).toString("base64url");
  const { data, error } = await db.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  ids.users.push(data.user.id);
  const client = anonClient();
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw signInError;
  return { client, userId: data.user.id };
}

const round = (value: number, decimals = 0) => Number(value.toFixed(decimals));

async function createCompany(key: "cl" | "uy" | "empty", country: string, currency: string) {
  const company = await ok(
    db.from("companies").insert({ name: `${PREFIX}${key.toUpperCase()} ${tag}`, country, currency }).select("id").single(),
    `company ${key}`,
  );
  const id = (company as { id: string }).id;
  ids.companies.push(id);
  ids[key] = id;
  return id;
}

async function areasOf(companyId: string) {
  const rows = await ok(db.from("business_areas").select("id, name").eq("company_id", companyId), "areas");
  const byName: Record<string, string> = {};
  for (const row of rows as { id: string; name: string }[]) byName[row.name] = row.id;
  for (const missing of ["Starlink", "Cloud"]) {
    if (!byName[missing]) {
      const created = await ok(
        memberA.from("business_areas").insert({ company_id: companyId, name: missing }).select("id").single(),
        `area ${missing}`,
      );
      byName[missing] = (created as { id: string }).id;
    }
  }
  return byName;
}

async function client(companyId: string, key: string) {
  const row = await ok(
    memberA.from("clients").insert({ company_id: companyId, name: `${PREFIX}${key} ${tag}` }).select("id").single(),
    `client ${key}`,
  );
  ids.client[key] = (row as { id: string }).id;
  return ids.client[key];
}

async function project(companyId: string, key: string, clientId: string, areaId: string, budget: number) {
  const { data, error } = await memberA.rpc("create_project_with_quote", {
    p_company_id: companyId,
    p_client_id: clientId,
    p_business_area_id: areaId,
    p_name: `${PREFIX}${key} ${tag}`,
    p_status: "en_ejecucion",
    p_quote_number: `${PREFIX}COT-${key}-${tag}`,
    p_start_date: "1998-01-01",
    p_end_date: null,
    p_budget: budget,
    p_responsible: null,
    p_invoiceable: true,
  });
  if (error) throw new Error(`project ${key}: ${error.message}`);
  ids.project[key] = (data as { id: string }).id;
  return ids.project[key];
}

type SaleSpec = {
  companyId: string;
  clientId: string;
  projectId?: string | null;
  areaId?: string | null;
  type: "invoice" | "credit_note";
  number: string;
  date: string;
  currency: string;
  net: number;
  vat: number;
  status: string;
  paidAt?: string;
};

async function sale(spec: SaleSpec) {
  const tax = round(spec.net * spec.vat, spec.currency === "CLP" ? 0 : 2);
  const row = await ok(
    db
      .from("sales_documents")
      .insert({
        company_id: spec.companyId,
        client_id: spec.clientId,
        project_id: spec.projectId ?? null,
        business_area_id: spec.areaId ?? null,
        document_type: spec.type,
        document_number: `${spec.number}${tag}`,
        document_date: spec.date,
        currency: spec.currency,
        net_amount: spec.net,
        tax_amount: tax,
        total_amount: spec.net + tax,
        source: "import",
        payment_status: spec.status,
        paid_at: spec.paidAt ?? null,
      })
      .select("id")
      .single(),
    `sale ${spec.number}`,
  );
  return (row as { id: string }).id;
}

async function cost(
  companyId: string,
  classification: "direct" | "general",
  projectId: string | null,
  date: string,
  currency: string,
  net: number,
  tax: number,
) {
  const { data, error } = await memberA.rpc("create_cost_document", {
    p_company_id: companyId,
    p_supplier_id: null,
    p_project_id: projectId,
    p_classification: classification,
    p_document_date: date,
    p_currency: currency,
    p_tax_amount: tax,
    p_lines: [{ description: `${PREFIX}costo`, amount: net }],
  });
  if (error) throw new Error(`cost: ${error.message}`);
  return (data as { id: string }).id;
}

type ServiceSpec = {
  companyId: string;
  key: string;
  clientId: string;
  areaId: string;
  type: "ms_licenses" | "hosting" | "starlink" | "server";
  currency: string;
  price: number;
  periodicity: "monthly" | "annual";
  mode: "advance" | "arrears";
  dueMonth?: number;
  fixedMonthlyCost?: number;
  usesPool?: boolean;
  requiresInvoice?: boolean;
  start?: string;
  end?: string;
};

async function service(spec: ServiceSpec) {
  const row = await ok(
    memberA
      .from("recurring_services")
      .insert({
        company_id: spec.companyId,
        client_id: spec.clientId,
        name: `${PREFIX}${spec.key} ${tag}`,
        price: spec.price,
        expected_cost: 0,
        currency: spec.currency,
        periodicity: spec.periodicity,
        invoicing_mode: spec.mode,
        due_day: 10,
        due_month: spec.dueMonth ?? null,
        start_date: spec.start ?? "1998-01-01",
        // Ended long ago: the cron and the month board never generate
        // cycles for these services on their own.
        end_date: spec.end ?? "1998-12-31",
        status: "active",
        active: true,
        service_type: spec.type,
        business_area_id: spec.areaId,
        fixed_monthly_cost: spec.fixedMonthlyCost ?? null,
        uses_cost_pool: spec.usesPool ?? false,
        requires_invoice: spec.requiresInvoice ?? true,
      })
      .select("id")
      .single(),
    `service ${spec.key}`,
  );
  return (row as { id: string }).id;
}

async function occurrence(
  key: string,
  serviceId: string,
  fields: {
    period: string;
    amount: number;
    currency: string;
    status: string;
    invoice_due_date?: string;
    invoiced_at?: string | null;
    collected_at?: string | null;
    sales_document_id?: string | null;
  },
) {
  const row = await ok(
    memberA
      .from("recurring_service_occurrences")
      .insert({
        recurring_service_id: serviceId,
        collection_due_date: fields.invoice_due_date ?? null,
        ...fields,
      })
      .select("id")
      .single(),
    `occurrence ${key}`,
  );
  ids.occurrence[key] = (row as { id: string }).id;
  return ids.occurrence[key];
}

async function pool(companyId: string, period: string, total: number, currency: string) {
  const row = await ok(
    memberA
      .from("recurring_service_cost_pools")
      .insert({ company_id: companyId, service_type: "ms_licenses", period, total_expense_amount: total, currency })
      .select("id")
      .single(),
    "pool",
  );
  const poolId = (row as { id: string }).id;
  const { data, error } = await memberA.rpc("allocate_recurring_service_cost_pool", { p_cost_pool_id: poolId });
  return { poolId, rows: (data ?? []) as { occurrence_id: string; allocated_amount: number }[], error: error?.message ?? null };
}

const pools: Record<string, Awaited<ReturnType<typeof pool>>> = {};

beforeAll(async () => {
  assertDevProject();

  // The 1998 FX months must be free (the table is global).
  const existing = await ok(
    db.from("exchange_rate_snapshots").select("currency, period").in("period", [FEB, P]),
    "fx check",
  );
  if ((existing as unknown[]).length > 0) throw new Error(`1998 FX snapshots already exist: ${JSON.stringify(existing)}`);
  await ok(db.from("exchange_rate_snapshots").insert(FX).select("id"), "fx insert");

  const cl = await createCompany("cl", "CL", "CLP");
  const uy = await createCompany("uy", "UY", "USD");
  const empty = await createCompany("empty", "CL", "CLP");

  const a = await signIn(`test_acct_${tag}_a@example.test`);
  const b = await signIn(`test_acct_${tag}_b@example.test`);
  memberA = a.client;
  memberB = b.client;
  await ok(
    db.from("company_memberships").insert([
      { user_id: a.userId, company_id: cl, role: "admin" },
      { user_id: a.userId, company_id: uy, role: "admin" },
      { user_id: a.userId, company_id: empty, role: "admin" },
      { user_id: b.userId, company_id: cl, role: "admin" },
    ]).select("id"),
    "memberships",
  );
  memberClient = memberA;

  ids.area.cl = await areasOf(cl);
  ids.area.uy = await areasOf(uy);
  const A = ids.area.cl;
  const AU = ids.area.uy;

  // ---------------- CHILE ----------------
  const C1 = await client(cl, "C1");
  const C2 = await client(cl, "C2");
  const C3 = await client(cl, "C3");
  const J1 = await project(cl, "J1", C1, A["Development"], 2_000_000);
  const J2 = await project(cl, "J2", C2, A["Networking"], 500_000);

  // S1's own area (IT Support) differs from its job's (Development) on
  // purpose: it must count once, under the job's area.
  await sale({ companyId: cl, clientId: C1, projectId: J1, areaId: A["IT Support"], type: "invoice", number: "F1-", date: "1998-03-10", currency: "CLP", net: 1_000_000, vat: 0.19, status: "pagado", paidAt: "1998-03-25" });
  const s2 = await sale({ companyId: cl, clientId: C1, projectId: J1, areaId: A["Development"], type: "invoice", number: "F2-", date: "1998-03-15", currency: "CLP", net: 300_000, vat: 0.19, status: "por_vencer" });
  const s3 = await sale({ companyId: cl, clientId: C1, projectId: J1, areaId: A["Development"], type: "credit_note", number: "NC1-", date: "1998-03-20", currency: "CLP", net: 300_000, vat: 0.19, status: "no_aplica" });
  const pair = await memberA.rpc("pair_credit_note", { p_credit_note_id: s3, p_invoice_id: s2 });
  if (pair.error) throw new Error(`pair: ${pair.error.message}`);
  await sale({ companyId: cl, clientId: C1, projectId: J1, areaId: A["Development"], type: "credit_note", number: "NC2-", date: "1998-03-22", currency: "CLP", net: 50_000, vat: 0.19, status: "no_aplica" });
  const s7 = await sale({ companyId: cl, clientId: C2, areaId: A["Microsoft 365"], type: "invoice", number: "F3-", date: "1998-03-06", currency: "CLP", net: 2_000, vat: 0.19, status: "por_vencer" });
  await sale({ companyId: cl, clientId: C2, type: "invoice", number: "F4-", date: "1998-02-28", currency: "CLP", net: 70_000, vat: 0.19, status: "pagado" });
  await sale({ companyId: cl, clientId: C2, type: "invoice", number: "F5-", date: "1998-04-01", currency: "CLP", net: 50_000, vat: 0.19, status: "por_vencer" });

  // Manual sales without invoice: S4 on the last day of the month, paid; S5 owed.
  const s4 = await memberA.rpc("create_manual_sale_without_invoice", { p_company_id: cl, p_project_id: J2, p_document_date: "1998-03-31", p_net_amount: 400_000, p_tax_amount: 76_000, p_description: `${PREFIX}S4` });
  if (s4.error) throw new Error(`s4: ${s4.error.message}`);
  const paid = await memberA.rpc("mark_sales_document_paid", { p_sales_document_id: (s4.data as { id: string }).id, p_paid_at: "1998-04-02", p_payment_method: "transferencia" });
  if (paid.error) throw new Error(`s4 paid: ${paid.error.message}`);
  const s5 = await memberA.rpc("create_manual_sale_without_invoice", { p_company_id: cl, p_project_id: J2, p_document_date: "1998-03-05", p_net_amount: 100_000, p_tax_amount: 0, p_description: `${PREFIX}S5` });
  if (s5.error) throw new Error(`s5: ${s5.error.message}`);

  // Costs.
  await cost(cl, "direct", J1, "1998-03-12", "CLP", 200_000, 38_000);
  await cost(cl, "general", null, "1998-03-01", "CLP", 80_000, 15_200);
  const k3 = await cost(cl, "general", null, "1998-03-14", "CLP", 120_000, 22_800);
  const alloc = await memberA.rpc("set_cost_allocations", {
    p_cost_document_id: k3,
    p_allocations: [
      { target_type: "client", target_id: C2, method: "percentage", value: 50 },
      { target_type: "business_area", target_id: A["Hosting"], method: "percentage", value: 50 },
    ],
  });
  if (alloc.error) throw new Error(`k3 alloc: ${alloc.error.message}`);

  // Payroll and technician.
  const employee = await ok(memberA.from("personnel").insert({ company_id: cl, name: `${PREFIX}Empleado ${tag}`, type: "employee" }).select("id").single(), "employee");
  const pc = await ok(memberA.from("personnel_costs").insert({ personnel_id: (employee as { id: string }).id, period: P, amount: 300_000, currency: "CLP" }).select("id").single(), "payroll");
  for (const [projectId, amount] of [[J1, 90_000], [J2, 60_000]] as const) {
    const w = await memberA.rpc("allocate_work", { p_personnel_cost_id: (pc as { id: string }).id, p_project_id: projectId, p_amount: amount, p_hours: null });
    if (w.error) throw new Error(`work: ${w.error.message}`);
  }
  const tech = await ok(memberA.from("personnel").insert({ company_id: cl, name: `${PREFIX}Tecnico ${tag}`, type: "contractor" }).select("id").single(), "technician");
  ids.personnel.tech = (tech as { id: string }).id;
  const charge = await memberA.rpc("create_technician_charge", { p_project_id: J1, p_personnel_id: ids.personnel.tech, p_description: `${PREFIX}cargo`, p_charge_date: "1998-03-18", p_amount: 119_000, p_vat_included: true, p_vat_rate: 0.19 });
  if (charge.error) throw new Error(`charge: ${charge.error.message}`);
  const payment = await memberA.rpc("record_technician_payment", { p_personnel_id: ids.personnel.tech, p_payment_date: "1998-03-28", p_amount: 50_000, p_method: "transferencia", p_notes: PREFIX, p_applications: [{ charge_id: (charge.data as { id: string }).id, amount: 50_000 }] });
  if (payment.error) throw new Error(`payment: ${payment.error.message}`);

  // Recurring services (Chile: always CLP).
  const ms = (key: string, clientId: string) =>
    service({ companyId: cl, key, clientId, areaId: A["Microsoft 365"], type: "ms_licenses", currency: "CLP", price: 1_000, periodicity: "monthly", mode: "advance", usesPool: true });
  const due = "1998-03-10";
  await occurrence("MS-a", await ms("MS-a", C1), { period: P, amount: 1_000, currency: "CLP", status: "invoiced", invoice_due_date: due, invoiced_at: "1998-03-05" });
  await occurrence("MS-b", await ms("MS-b", C2), { period: P, amount: 1_000, currency: "CLP", status: "invoiced", invoice_due_date: due, invoiced_at: "1998-03-06", sales_document_id: s7 });
  await occurrence("MS-c", await ms("MS-c", C3), { period: P, amount: 1_000, currency: "CLP", status: "collected", invoice_due_date: due, invoiced_at: "1998-03-05", collected_at: "1998-03-20" });
  await occurrence("MS-z", await ms("MS-z", C3), { period: P, amount: 0, currency: "CLP", status: "invoiced", invoice_due_date: due, invoiced_at: "1998-03-05" });
  await occurrence("MS-v", await ms("MS-v", C1), { period: P, amount: 3_000, currency: "CLP", status: "void", invoice_due_date: due });
  pools.clMarch = await pool(cl, P, 1_000, "CLP");

  const hosting = await service({ companyId: cl, key: "Hosting", clientId: C1, areaId: A["Hosting"], type: "hosting", currency: "CLP", price: 120_000, periodicity: "annual", mode: "advance", dueMonth: 3, fixedMonthlyCost: 2_000 });
  await occurrence("Hosting", hosting, { period: "1998-01-01", amount: 120_000, currency: "CLP", status: "collected", invoice_due_date: due, invoiced_at: "1998-03-08", collected_at: "1998-03-15" });
  const starlink = await service({ companyId: cl, key: "Starlink", clientId: C2, areaId: A["Starlink"], type: "starlink", currency: "CLP", price: 50_000, periodicity: "monthly", mode: "arrears", fixedMonthlyCost: 30_000 });
  await occurrence("Starlink", starlink, { period: FEB, amount: 50_000, currency: "CLP", status: "invoiced", invoice_due_date: due, invoiced_at: "1998-03-03" });
  const cloud = await service({ companyId: cl, key: "Cloud", clientId: C2, areaId: A["Cloud"], type: "server", currency: "CLP", price: 10_000, periodicity: "monthly", mode: "advance", fixedMonthlyCost: 4_000, requiresInvoice: false });
  await occurrence("Cloud", cloud, { period: P, amount: 10_000, currency: "CLP", status: "pending_collection", invoice_due_date: due });

  // A pool whose shares all round up: 4 cycles of 1 CLP, invoice of 2 CLP.
  for (const key of ["R1", "R2", "R3", "R4"]) {
    const id = await service({ companyId: cl, key, clientId: C3, areaId: A["Microsoft 365"], type: "ms_licenses", currency: "CLP", price: 1, periodicity: "monthly", mode: "advance", usesPool: true });
    await occurrence(key, id, { period: "1998-05-01", amount: 1, currency: "CLP", status: "invoiced", invoice_due_date: "1998-05-10", invoiced_at: "1998-05-05" });
  }
  pools.clMay = await pool(cl, "1998-05-01", 2, "CLP");

  // A service managed from September 2026: paid in September, owed in October.
  const live = await service({ companyId: cl, key: "Hosting-2026", clientId: C1, areaId: A["Hosting"], type: "hosting", currency: "CLP", price: 10_000, periodicity: "monthly", mode: "advance", start: "2026-09-01", end: "2026-10-31" });
  await occurrence("2026-09", live, { period: "2026-09-01", amount: 10_000, currency: "CLP", status: "collected", invoice_due_date: "2026-09-05", invoiced_at: "2026-09-02", collected_at: "2026-09-20" });
  await occurrence("2026-10", live, { period: "2026-10-01", amount: 10_000, currency: "CLP", status: "invoiced", invoice_due_date: "2026-10-05", invoiced_at: "2026-10-01" });

  // ---------------- URUGUAY ----------------
  const U1 = await client(uy, "U1");
  const U2 = await client(uy, "U2");
  const JU1 = await project(uy, "JU1", U1, AU["Development"], 5_000);
  await sale({ companyId: uy, clientId: U1, projectId: JU1, areaId: AU["Development"], type: "invoice", number: "UF1-", date: "1998-03-11", currency: "USD", net: 2_000, vat: 0.22, status: "por_vencer" });
  await sale({ companyId: uy, clientId: U2, areaId: AU["IT Support"], type: "invoice", number: "UF2-", date: "1998-03-12", currency: "UYU", net: 40_000, vat: 0.22, status: "pagado", paidAt: "1998-03-30" });
  const su3 = await memberA.rpc("create_manual_sale_without_invoice", { p_company_id: uy, p_project_id: JU1, p_document_date: "1998-03-20", p_net_amount: 500, p_tax_amount: 110, p_description: `${PREFIX}SU3` });
  if (su3.error) throw new Error(`su3: ${su3.error.message}`);
  await cost(uy, "direct", JU1, "1998-03-13", "USD", 800, 176);
  await cost(uy, "general", null, "1998-03-02", "UYU", 20_000, 4_400);
  const hostingUy = await service({ companyId: uy, key: "Hosting-UY", clientId: U1, areaId: AU["Hosting"], type: "hosting", currency: "USD", price: 100, periodicity: "monthly", mode: "advance", fixedMonthlyCost: 30 });
  await occurrence("Hosting-UY", hostingUy, { period: P, amount: 100, currency: "USD", status: "invoiced", invoice_due_date: due, invoiced_at: "1998-03-02" });
  const msUy = await service({ companyId: uy, key: "MS-UY", clientId: U2, areaId: AU["Microsoft 365"], type: "ms_licenses", currency: "UYU", price: 4_000, periodicity: "monthly", mode: "advance", usesPool: true });
  await occurrence("MS-UY", msUy, { period: P, amount: 4_000, currency: "UYU", status: "collected", invoice_due_date: due, invoiced_at: "1998-03-04", collected_at: "1998-03-09" });
  pools.uyMarch = await pool(uy, P, 2_000, "UYU");
}, 300_000);

/** Deletes every row of `companies` in foreign-key order; failures are collected, never thrown. */
async function deleteCompanies(companies: string[], failures: string[]) {
  const step = async (label: string, p: PromiseLike<{ error: unknown }>) => {
    const { error } = await p;
    if (error) failures.push(`${label}: ${JSON.stringify(error)}`);
  };
  if (companies.length > 0) {
    const services = ((await db.from("recurring_services").select("id").in("company_id", companies)).data ?? []).map((r) => r.id);
    const poolIds = ((await db.from("recurring_service_cost_pools").select("id").in("company_id", companies)).data ?? []).map((r) => r.id);
    const costDocs = ((await db.from("cost_documents").select("id").in("company_id", companies)).data ?? []).map((r) => r.id);
    const personnel = ((await db.from("personnel").select("id").in("company_id", companies)).data ?? []).map((r) => r.id);
    const payrolls = ((await db.from("personnel_costs").select("id").in("personnel_id", personnel.length ? personnel : ["00000000-0000-0000-0000-000000000000"])).data ?? []).map((r) => r.id);
    const projects = ((await db.from("projects").select("id").in("company_id", companies)).data ?? []).map((r) => r.id);
    const none = ["00000000-0000-0000-0000-000000000000"];
    const list = (values: string[]) => (values.length ? values : none);

    await step("rs allocations", db.from("recurring_service_cost_allocations").delete().in("cost_pool_id", list(poolIds)));
    await step("pools", db.from("recurring_service_cost_pools").delete().in("company_id", companies));
    await step("occurrences", db.from("recurring_service_occurrences").delete().in("recurring_service_id", list(services)));
    await step("services", db.from("recurring_services").delete().in("company_id", companies));
    await step("tech applications", db.from("technician_payment_applications").delete().in("company_id", companies));
    await step("tech payments", db.from("technician_payments").delete().in("company_id", companies));
    await step("tech charges", db.from("technician_charges").delete().in("company_id", companies));
    await step("work", db.from("work_allocations").delete().in("personnel_cost_id", list(payrolls)));
    await step("payroll", db.from("personnel_costs").delete().in("id", list(payrolls)));
    await step("personnel", db.from("personnel").delete().in("company_id", companies));
    await step("cost allocations", db.from("cost_allocations").delete().in("cost_document_id", list(costDocs)));
    await step("cost lines", db.from("cost_lines").delete().in("cost_document_id", list(costDocs)));
    await step("cost confirmations", db.from("project_cost_confirmations").delete().in("project_id", list(projects)));
    await step("cost docs", db.from("cost_documents").delete().in("company_id", companies));
    await step("unpair", db.from("sales_documents").update({ annulled_by_document_id: null, annuls_document_id: null }).in("company_id", companies));
    const sales = ((await db.from("sales_documents").select("id").in("company_id", companies)).data ?? []).map((r) => r.id);
    const batches = ((await db.from("import_batches").select("id").in("company_id", companies)).data ?? []).map((r) => r.id);
    // import_rows and sales_documents point at each other: unlink first.
    await step("unlink import rows", db.from("sales_documents").update({ import_row_id: null }).in("company_id", companies));
    await step("import rows", db.from("import_rows").delete().in("import_batch_id", list(batches)));
    await step("sales lines", db.from("sales_lines").delete().in("sales_document_id", list(sales)));
    await step("sales", db.from("sales_documents").delete().in("company_id", companies));
    await step("import batches", db.from("import_batches").delete().in("company_id", companies));
    await step("quotes", db.from("project_quotes").delete().in("company_id", companies));
    await step("projects", db.from("projects").delete().in("company_id", companies));
    await step("suppliers", db.from("suppliers").delete().in("company_id", companies));
    await step("clients", db.from("clients").delete().in("company_id", companies));
    await step("areas", db.from("business_areas").delete().in("company_id", companies));
    await step("memberships", db.from("company_memberships").delete().in("company_id", companies));
    await step("companies", db.from("companies").delete().in("id", companies));
  }
}

afterAll(async () => {
  const failures: string[] = [];
  const step = async (label: string, p: PromiseLike<{ error: unknown }>) => {
    const { error } = await p;
    if (error) failures.push(`${label}: ${JSON.stringify(error)}`);
  };
  await deleteCompanies(ids.companies, failures);
  await step("fx", db.from("exchange_rate_snapshots").delete().in("period", [FEB, P]).in("currency", ["CLP", "UYU"]));
  for (const userId of ids.users) {
    const { error } = await db.auth.admin.deleteUser(userId);
    if (error) failures.push(`user ${userId}: ${error.message}`);
  }

  // Proof nothing is left behind.
  const leftCompanies = (await db.from("companies").select("id", { count: "exact", head: true }).like("name", `${PREFIX}%${tag}`)).count;
  const leftFx = (await db.from("exchange_rate_snapshots").select("id", { count: "exact", head: true }).in("period", [FEB, P])).count;
  report.cleanup = { failures, leftCompanies, leftFx };
  if (OUT) writeFileSync(OUT, JSON.stringify(report, null, 2));
  if (failures.length > 0 || leftCompanies !== 0 || leftFx !== 0) {
    throw new Error(`Cleanup incomplete (tag ${tag}): ${JSON.stringify(report.cleanup)}`);
  }
}, 300_000);

// ---------------------------------------------------------------------

describe("Chile -- Resultado mensual (home y consolidado)", () => {
  it("matches the hand-computed statement", async () => {
    const m = await computeMonthlyResult(ids.cl, P);
    report.clMonthly = m;
    expect(m.hasError, JSON.stringify(m.errors)).toBe(false);
    expect(m.currencyConversionPending).toBe(false);
    expect(m.netSales).toBe(CL.netSales);
    expect(m.directCosts).toBe(CL.directCosts);
    expect(m.directMargin).toBe(CL.directMargin);
    expect(m.generalCosts).toBe(CL.generalCosts);
    expect(m.operatingResult).toBe(CL.operatingResult);
    expect(m.recurringRevenue).toBe(172_000);
    expect(m.recurringCosts).toBe(55_000);
    // "Proyectos sin costo registrado": J2 has no cost document in March
    // (only 60.000 of payroll imputed), so the current rule flags it.
    expect(m.pendingProjectCount).toBe(1);
  });

  it("dashboard series (KPIs, gráfico, waterfall) equals the monthly result, month by month", async () => {
    const series = await getMonthlySeries(ids.cl, P, 12);
    const march = series[series.length - 1];
    const feb = series[series.length - 2];
    report.clSeries = { march, feb };
    expect(march.period).toBe(P);
    expect(march.netSales).toBe(CL.netSales);
    expect(march.directCosts).toBe(CL.directCosts);
    expect(march.generalCosts).toBe(CL.generalCosts);
    expect(march.operatingResult).toBe(CL.operatingResult);
    expect(feb.netSales).toBe(CL.febNetSales);
    expect(march.pendingProjectCount).toBe(1);
    // A document dated 01-04 is April's, never March's.
    const april = (await getMonthlySeries(ids.cl, "1998-04-01", 1))[0];
    expect(april.netSales).toBe(50_000);
  });
});

describe("Chile -- Rentabilidad por trabajo, cliente y área", () => {
  it("jobs", async () => {
    const p = await getProfitabilityBreakdown(ids.cl, P);
    report.clBreakdown = p;
    for (const [key, expected] of Object.entries(CL.projects)) {
      const row = p.projects.find((x) => x.id === ids.project[key]);
      expect({ key, revenue: row?.revenue, costs: row?.costs, margin: row?.margin }).toEqual({ key, ...expected });
    }
    // Dashboard "Vs. presupuesto": accumulated costs - budget (both jobs under).
    expect(p.projects.find((x) => x.id === ids.project.J1)?.budgetVariance).toBe(390_000 - 2_000_000);
    expect(p.projects.find((x) => x.id === ids.project.J2)?.budgetVariance).toBe(60_000 - 500_000);
  });

  it("the job's own page shows the same figures as the report (net, credit notes subtract)", async () => {
    const page = await computeProjectProfitability(ids.cl, ids.project.J1, P);
    report.clJ1Page = page;
    expect({ revenue: page.revenue, costs: page.costs, margin: page.margin }).toEqual(CL.projects.J1);
  });

  it("clients", async () => {
    const p = await getProfitabilityBreakdown(ids.cl, P);
    let poolPart = 0;
    for (const [key, expected] of Object.entries(CL.clients)) {
      const row = p.clients.find((x) => x.id === ids.client[key]);
      expect({ key, revenue: row?.revenue }).toEqual({ key, revenue: expected.revenue });
      const pool = (row?.costs ?? 0) - expected.costsWithoutPool;
      expect(pool, `${key} pool share`).toBeGreaterThanOrEqual(0);
      poolPart += pool;
    }
    expect(poolPart).toBe(CL.poolTotal);
  });

  it("areas: each sale counted once", async () => {
    const p = await getProfitabilityBreakdown(ids.cl, P);
    for (const [name, expected] of Object.entries(CL.areas)) {
      const row = p.areas.find((x) => x.id === ids.area.cl[name]);
      expect({ name, revenue: row?.revenue, costs: row?.costs }).toEqual({ name, ...expected });
    }
    expect(p.areas.find((x) => x.id === ids.area.cl["IT Support"])?.revenue).toBe(0);
  });
});

describe("Invariantes de cuadre", () => {
  it("Chile: Σ clientes = Σ áreas = Resultado mensual (más lo no asignado)", async () => {
    const [m, p] = await Promise.all([computeMonthlyResult(ids.cl, P), getProfitabilityBreakdown(ids.cl, P)]);
    const clientRevenue = p.clients.reduce((s, x) => s + x.revenue, 0);
    const areaRevenue = p.areas.reduce((s, x) => s + x.revenue, 0);
    const clientCosts = p.clients.reduce((s, x) => s + x.costs, 0);
    const areaCosts = p.areas.reduce((s, x) => s + x.costs, 0);
    const totalCosts = m.directCosts + m.generalCosts;
    report.invariantsCL = { clientRevenue, areaRevenue, netSales: m.netSales, clientCosts, areaCosts, totalCosts };
    expect(clientRevenue).toBe(m.netSales);
    expect(areaRevenue).toBe(m.netSales);
    expect(clientCosts + CL.unassignedClientCosts).toBe(totalCosts);
    expect(areaCosts + CL.unassignedAreaCosts).toBe(totalCosts);
  });

  it("Chile: Σ trabajos + recurrentes + no asignado = Resultado mensual", async () => {
    const [m, p] = await Promise.all([computeMonthlyResult(ids.cl, P), getProfitabilityBreakdown(ids.cl, P)]);
    const jobs = p.projects.reduce((s, x) => s + x.margin, 0);
    // Outside jobs, by hand: recurring 172.000 - 55.000 + S7 2.000 (no job)
    // - K2 80.000 - K3 120.000 - payroll not imputed 150.000.
    const outsideJobs = 172_000 - 55_000 + 2_000 - 80_000 - 120_000 - 150_000;
    expect(jobs + outsideJobs).toBe(m.operatingResult);
  });

  it("Uruguay: monthly, clients, areas (USD, UYU converted at the month's rate)", async () => {
    const [m, p] = await Promise.all([computeMonthlyResult(ids.uy, P), getProfitabilityBreakdown(ids.uy, P)]);
    report.uyMonthly = m;
    report.uyBreakdown = { clients: p.clients, areas: p.areas };
    expect(m.currencyConversionPending).toBe(false);
    expect(round(m.netSales, 2)).toBe(UY.netSales);
    expect(round(m.directCosts, 2)).toBe(UY.directCosts);
    expect(round(m.generalCosts, 2)).toBe(UY.generalCosts);
    expect(round(m.operatingResult, 2)).toBe(UY.operatingResult);
    for (const [key, expected] of Object.entries(UY.clients)) {
      const row = p.clients.find((x) => x.id === ids.client[key]);
      expect({ key, revenue: round(row?.revenue ?? NaN, 2), costs: round(row?.costs ?? NaN, 2) }).toEqual({ key, ...expected });
    }
    for (const [name, expected] of Object.entries(UY.areas)) {
      const row = p.areas.find((x) => x.id === ids.area.uy[name]);
      expect({ name, revenue: round(row?.revenue ?? NaN, 2), costs: round(row?.costs ?? NaN, 2) }).toEqual({ name, ...expected });
    }
    const clientCosts = p.clients.reduce((s, x) => s + x.costs, 0);
    expect(round(clientCosts + UY.unassigned, 2)).toBe(round(m.directCosts + m.generalCosts, 2));
  });

  it("consolidado USD = Σ resultados convertidos con la tasa del período", async () => {
    const c = await computeConsolidatedResult(P);
    report.consolidated = c;
    const mine = c.companies.filter((x) => ids.companies.includes(x.companyId));
    expect(mine.map((x) => x.companyId).sort()).toEqual([...ids.companies].sort());
    const sum = mine.reduce((s, x) => s + (x.usdAmount ?? 0), 0);
    expect(round(sum, 2)).toBe(CONSOLIDATED_USD);
  });

  it("reparto de licencias: suma = total, sin negativos, anuladas y venta 0 sin costo", async () => {
    report.pools = pools;
    for (const [key, p] of Object.entries(pools)) {
      expect(p.error, key).toBeNull();
      expect(p.rows.every((r) => Number(r.allocated_amount) >= 0), `${key} negative share`).toBe(true);
    }
    const march = pools.clMarch.rows;
    expect(march.reduce((s, r) => s + Number(r.allocated_amount), 0)).toBe(1_000);
    expect(march.find((r) => r.occurrence_id === ids.occurrence["MS-v"])).toBeUndefined();
    expect(Number(march.find((r) => r.occurrence_id === ids.occurrence["MS-z"])?.allocated_amount ?? 0)).toBe(0);
    const shares = ["MS-a", "MS-b", "MS-c"].map((k) => Number(march.find((r) => r.occurrence_id === ids.occurrence[k])?.allocated_amount)).sort();
    expect(shares).toEqual([333, 333, 334]);
    const may = pools.clMay.rows.map((r) => Number(r.allocated_amount)).sort();
    expect(may).toEqual([0, 0, 1, 1]);
    expect(pools.uyMarch.rows.map((r) => Number(r.allocated_amount))).toEqual([2_000]);
  });

  it("asignaciones ≤ costo del documento (gastos, sueldos)", async () => {
    const [allocations, work] = await Promise.all([
      ok(db.from("cost_allocations").select("method, percentage, amount, cost_documents!inner(company_id, total_amount)").in("cost_documents.company_id", ids.companies), "alloc"),
      ok(db.from("work_allocations").select("amount, personnel_costs!inner(amount, personnel!inner(company_id))").in("personnel_costs.personnel.company_id", ids.companies), "work"),
    ]);
    const shares = (allocations as { method: string; percentage: number | null; amount: number | null; cost_documents: { total_amount: number } }[])
      .reduce((s, r) => s + (r.method === "percentage" ? (Number(r.cost_documents.total_amount) * Number(r.percentage)) / 100 : Number(r.amount)), 0);
    expect(shares).toBe(142_800);
    expect((work as { amount: number }[]).reduce((s, r) => s + Number(r.amount), 0)).toBeLessThanOrEqual(300_000);
  });

  it("técnicos: cargos − pagos aplicados = saldo mostrado", async () => {
    const charges = await getTechnicianCharges(ids.cl);
    const summary = summarizeByTechnician(
      charges.map((c) => ({ ...c, document_status: c.document_status as "pendiente" | "recibida" })),
    ).get(ids.personnel.tech);
    report.technician = summary;
    expect(summary?.charged).toBe(119_000);
    expect(summary?.paid).toBe(50_000);
    expect(summary?.balance).toBe(CL.technicianBalance);
  });

  it("cobros de ventas: facturado = cobrado + pendiente (marzo, por cliente)", async () => {
    const rows = await ok(
      memberA
        .from("sales_documents")
        .select("client_id, document_type, total_amount, payment_status, annulled_by_document_id, document_date")
        .eq("company_id", ids.cl)
        .eq("voided", false)
        .gte("document_date", P)
        .lt("document_date", "1998-04-01"),
      "sales",
    );
    // Billed = what clients owe: invoices and manual sales (credit notes and
    // the invoices they annul are voided, so already out).
    const billed = (rows as { client_id: string; document_type: string; total_amount: number; payment_status: string | null; annulled_by_document_id: string | null }[])
      .filter((r) => r.document_type !== "credit_note" && !r.annulled_by_document_id);
    const sum = (list: typeof billed) => list.reduce((s, r) => s + Number(r.total_amount), 0);
    const collected = billed.filter((r) => r.payment_status === "pagado");
    const pending = billed.filter((r) => r.payment_status !== "pagado");
    expect(sum(billed)).toBe(CL.billedGross);
    expect(sum(collected)).toBe(CL.collectedGross);
    expect(sum(pending)).toBe(CL.pendingGross);
    // The pendientes screen lists S5 (manual, owed) and not S4 (paid).
    const pendingScreen = await getSalesPending(ids.cl, new Date("1998-06-01T12:00:00Z"));
    const manual = pendingScreen.unpaidManualSales.map((r) => r.netAmount);
    report.salesPending = { manual, stale: pendingScreen.staleUnpaidInvoices.map((r) => r.documentNumber) };
    expect(manual).toEqual([100_000]);
  });
});

describe("Servicios recurrentes desde septiembre 2026 (tablero, tarjeta del dashboard, deuda)", () => {
  it("septiembre pagado, octubre se debe; totales por moneda cuadran", async () => {
    const sep = await getRecurringServiceOccurrencesForMonth(ids.cl, "2026-09");
    const oct = await getRecurringServiceOccurrencesForMonth(ids.cl, "2026-10");
    const sepT = totalsByCurrency(sep, "2026-10-04");
    const octT = totalsByCurrency(oct, "2026-10-04");
    report.board = { sep: sepT, oct: octT };
    expect(sepT).toEqual([{ currency: "CLP", toInvoice: 0, toCollect: 0, collected: 10_000, overdue: 0 }]);
    expect(octT).toEqual([{ currency: "CLP", toInvoice: 0, toCollect: 10_000, collected: 0, overdue: 0 }]);
    // The dashboard card's counts for October, as of 04-10 and as of 06-10.
    expect(oct.filter((c) => c.status === "invoiced" || c.status === "pending_collection").length).toBe(1);
    expect(oct.filter((c) => isOverdue(c, "2026-10-04")).length).toBe(0);
    expect(oct.filter((c) => isOverdue(c, "2026-10-06")).length).toBe(1);
  });

  it("marzo 1998: por facturar + por cobrar + cobrado = todo lo no anulado", async () => {
    const march = await getRecurringServiceOccurrencesForMonth(ids.cl, "1998-03");
    const [t] = totalsByCurrency(march);
    // a 1.000 inv + b 1.000 inv + c 1.000 coll + z 0 + Hosting 120.000 coll
    // + Starlink 50.000 inv + Cloud 10.000 pending_collection; v void excluded.
    expect(t).toEqual({ currency: "CLP", toInvoice: 0, toCollect: 62_000, collected: 121_000 });
  });
});

describe("Aislamiento y estados vacíos", () => {
  it("empresa sin datos: todo en cero, sin errores", async () => {
    const [m, series, p] = await Promise.all([
      computeMonthlyResult(ids.empty, P),
      getMonthlySeries(ids.empty, P, 12),
      getProfitabilityBreakdown(ids.empty, P),
    ]);
    expect(m.hasError).toBe(false);
    expect([m.netSales, m.directCosts, m.generalCosts, m.operatingResult]).toEqual([0, 0, 0, 0]);
    expect(series.every((x) => x.netSales === 0 && x.operatingResult === 0)).toBe(true);
    expect(p.projects).toEqual([]);
    expect(p.clients).toEqual([]);
  });

  it("un usuario de otra empresa no ve nada de Uruguay", async () => {
    memberClient = memberB;
    try {
      const [m, p, c] = await Promise.all([
        computeMonthlyResult(ids.uy, P),
        getProfitabilityBreakdown(ids.uy, P),
        computeConsolidatedResult(P),
      ]);
      expect(m.netSales).toBe(0);
      expect(p.clients).toEqual([]);
      expect(c.companies.map((x) => x.companyId)).toEqual([ids.cl]);
    } finally {
      memberClient = memberA;
    }
  });
});

// ---------------------------------------------------------------------
// Puntos abiertos resueltos (docs/verificacion-contable-2026-10-04.md,
// "Puntos abiertos resueltos"). Their own throwaway companies, prefix
// TEST_ACCT2_, so nothing here ever moves the oracle above. Same rules:
// expected figures by hand, real member with RLS, everything deleted.
// ---------------------------------------------------------------------

const PREFIX2 = "TEST_ACCT2_";
// 1997 FX months are created and deleted here (the table is global).
const FX2 = ["1997-01-01", "1997-06-01", "1997-07-01"];
const ids2 = {
  companies: [] as string[],
  cl: "",
  uy: "",
  area: {} as Record<string, string>,
  client: {} as Record<string, string>,
  project: {} as Record<string, string>,
  sale: {} as Record<string, string>,
};
let member2: SupabaseClient;

/** A Nubox export row (the CSV's own headers), amounts as whole pesos. */
function nuboxRow(folio: string, rut: string, name: string, date: string, net: number, due: string) {
  const tax = Math.round(net * 0.19);
  return {
    Fecha: date,
    Documento: "FAC-EL",
    Folio: folio,
    "Rut Cliente": rut,
    Cliente: name,
    "Monto neto": String(net),
    "Monto exento": "0",
    "Monto IVA": String(tax),
    "Monto impuestos": "0",
    "Monto total": String(net + tax),
    Estado: "Emitido",
    "Fecha vencimiento": due,
    "Estado de cobro": "TO_EXPIRE",
  };
}

describe("Puntos abiertos resueltos (TEST_ACCT2_)", () => {
  beforeAll(async () => {
    const taken = await ok(db.from("exchange_rate_snapshots").select("currency, period").in("period", FX2), "fx 1997 check");
    if ((taken as unknown[]).length > 0) throw new Error(`1997 FX snapshots already exist: ${JSON.stringify(taken)}`);

    const company = await ok(
      db.from("companies").insert({ name: `${PREFIX2}CL ${tag}`, country: "CL", currency: "CLP" }).select("id").single(),
      "company acct2",
    );
    ids2.cl = (company as { id: string }).id;
    ids2.companies.push(ids2.cl);
    const companyUy = await ok(
      db.from("companies").insert({ name: `${PREFIX2}UY ${tag}`, country: "UY", currency: "UYU" }).select("id").single(),
      "company acct2 uy",
    );
    ids2.uy = (companyUy as { id: string }).id;
    ids2.companies.push(ids2.uy);

    const m = await signIn(`test_acct2_${tag}@example.test`);
    member2 = m.client;
    await ok(
      db.from("company_memberships").insert([
        { user_id: m.userId, company_id: ids2.cl, role: "admin" },
        { user_id: m.userId, company_id: ids2.uy, role: "admin" },
      ]).select("id"),
      "membership acct2",
    );
    memberClient = member2;

    const areas = await ok(db.from("business_areas").select("id, name").eq("company_id", ids2.cl), "areas acct2");
    for (const row of areas as { id: string; name: string }[]) ids2.area[row.name] = row.id;

    for (const [key, rut] of [["K1", "70000001-1"], ["K2", "70000002-2"], ["K3", "70000003-3"]] as const) {
      const row = await ok(
        member2.from("clients").insert({ company_id: ids2.cl, name: `${PREFIX2}${key} ${tag}`, tax_id: rut }).select("id").single(),
        `client ${key}`,
      );
      ids2.client[key] = (row as { id: string }).id;
    }

    const job = async (key: string, clientKey: string, quoted: number) => {
      const { data, error } = await member2.rpc("create_project_with_quote", {
        p_company_id: ids2.cl,
        p_client_id: ids2.client[clientKey],
        p_business_area_id: ids2.area["Development"],
        p_name: `${PREFIX2}${key} ${tag}`,
        p_status: "en_ejecucion",
        p_quote_number: `${PREFIX2}COT-${key}-${tag}`,
        p_start_date: "1998-01-01",
        p_end_date: null,
        p_budget: quoted,
        p_responsible: null,
        p_invoiceable: true,
      });
      if (error) throw new Error(`job ${key}: ${error.message}`);
      ids2.project[key] = (data as { id: string }).id;
    };
    await job("JK1", "K1", 100_000);
    await job("JK2", "K2", 100_000);
    await job("JK3", "K3", 70_000);

    const manualSale = async (key: string, projectKey: string, date: string, net: number) => {
      const { data, error } = await member2.rpc("create_manual_sale_without_invoice", {
        p_company_id: ids2.cl,
        p_project_id: ids2.project[projectKey],
        p_document_date: date,
        p_net_amount: net,
        p_tax_amount: 0,
        p_description: `${PREFIX2}${key}`,
      });
      if (error) throw new Error(`manual sale ${key}: ${error.message}`);
      ids2.sale[key] = (data as { id: string }).id;
    };
    // K1: one venta sin factura, invoiced in Nubox 11 days later for 1 peso more.
    await manualSale("MK1", "JK1", "1998-07-25", 100_000);
    // K2: two alike ventas sin factura around the invoice date -> ambiguous.
    await manualSale("MK2a", "JK2", "1998-07-10", 50_000);
    await manualSale("MK2b", "JK2", "1998-07-20", 50_000);
    // K3: a venta sin factura long before the invoice: not adopted, but the
    // job is already sold, so the invoice must not be suggested for it.
    await manualSale("MK3", "JK3", "1998-03-01", 70_000);
  }, 300_000);

  afterAll(async () => {
    memberClient = memberA;
    const failures: string[] = [];
    await deleteCompanies(ids2.companies, failures);
    const fx = await db.from("exchange_rate_snapshots").delete().in("period", FX2);
    if (fx.error) failures.push(`fx 1997: ${fx.error.message}`);
    const left = (await db.from("companies").select("id", { count: "exact", head: true }).like("name", `${PREFIX2}%${tag}`)).count;
    const leftFx = (await db.from("exchange_rate_snapshots").select("id", { count: "exact", head: true }).in("period", FX2)).count;
    report.cleanupAcct2 = { failures, left, leftFx };
    if (failures.length > 0 || left !== 0 || leftFx !== 0) throw new Error(`Cleanup TEST_ACCT2_ incomplete: ${JSON.stringify(report.cleanupAcct2)}`);
  }, 300_000);

  describe("1. Venta sin factura que después se factura en Nubox", () => {
    it("no vuelve a sugerir el trabajo que ya tiene esa venta", async () => {
      const analysis = await analyzeNuboxRows(ids2.cl, [
        nuboxRow("9003", "70000003-3", "K3", "01/09/1998", 70_000, "01/10/1998"),
      ]);
      expect(analysis.classifications.get(1)?.kind).toBe("new");
      const balances = await getProjectBillingBalances(ids2.cl);
      expect(balances.find((b) => b.projectId === ids2.project.JK3)?.invoicedAmount).toBe(70_000);
      expect(analysis.invoiceLinks.find((l) => l.documentNumber === "9003")?.suggestedProjectId).toBeNull();
    });

    it("la factura adopta la única venta sin factura parecida; con dos candidatas no adopta y pide revisión", async () => {
      const rows = [
        nuboxRow("9001", "70000001-1", "K1", "05/08/1998", 100_001, "05/09/1998"),
        nuboxRow("9002", "70000002-2", "K2", "15/07/1998", 50_000, "15/08/1998"),
      ];
      const preview = await analyzeNuboxRows(ids2.cl, rows);
      expect(preview.classifications.get(1)?.kind).toBe("adopt");
      expect(preview.classifications.get(2)?.kind).toBe("ambiguous");

      const result = await commitNuboxImport(ids2.cl, `${PREFIX2}nubox.csv`, rows, { pairs: {}, links: {} });
      report.acct2Import = result;
      if (result.error !== null) throw new Error(result.error);
      expect(result.counts).toMatchObject({ imported: 0, adopted: 1, review: 1 });
      expect(result.rowResults.find((r) => r.folio === "9002")?.message).toMatch(/revisión/i);

      const sales = (await ok(
        db.from("sales_documents").select("id, document_number, document_type, document_date, recognized_period, net_amount, total_amount, project_id").eq("company_id", ids2.cl),
        "sales acct2",
      )) as { id: string; document_number: string | null; document_type: string; document_date: string; recognized_period: string | null; net_amount: number; total_amount: number; project_id: string | null }[];
      // No sale was created: the four ventas sin factura are still the only ones.
      expect(sales.length).toBe(4);
      const mk1 = sales.find((s) => s.id === ids2.sale.MK1)!;
      expect(mk1).toMatchObject({
        document_number: "9001",
        document_type: "invoice",
        document_date: "1998-08-05",
        // The revenue stays in July, where the venta sin factura recognised it.
        recognized_period: "1998-07-01",
        project_id: ids2.project.JK1,
      });
      expect(Number(mk1.net_amount)).toBe(100_001);
      expect(Number(mk1.total_amount)).toBe(119_001);
      expect(sales.some((s) => s.document_number === "9002")).toBe(false);
      const lines = (await ok(db.from("sales_lines").select("amount").eq("sales_document_id", ids2.sale.MK1), "lines")) as { amount: number }[];
      expect(lines.map((l) => Number(l.amount))).toEqual([100_001]);

      // By hand: July = MK1 100.001 + MK2a 50.000 + MK2b 50.000; August = 0.
      const [july, august] = await Promise.all([
        computeMonthlyResult(ids2.cl, "1998-07-01"),
        computeMonthlyResult(ids2.cl, "1998-08-01"),
      ]);
      expect(july.netSales).toBe(200_001);
      expect(august.netSales).toBe(0);

      // Re-importing the same file changes nothing (folio now known; K2 still ambiguous).
      const again = await analyzeNuboxRows(ids2.cl, rows);
      expect(again.classifications.get(1)?.kind).toBe("unchanged");
      expect(again.classifications.get(2)?.kind).toBe("ambiguous");
    });
  });
  describe("2. Pool de licencias MS: se carga neto", () => {
    it("el costo del reparto es el neto; el total con IVA es solo referencia", async () => {
      const service = await ok(
        member2
          .from("recurring_services")
          .insert({
            company_id: ids2.cl,
            client_id: ids2.client.K1,
            name: `${PREFIX2}MS ${tag}`,
            price: 20_000,
            expected_cost: 0,
            currency: "CLP",
            periodicity: "monthly",
            invoicing_mode: "advance",
            due_day: 10,
            start_date: "1998-01-01",
            end_date: "1998-12-31",
            status: "active",
            active: true,
            service_type: "ms_licenses",
            business_area_id: ids2.area["Microsoft 365"],
            uses_cost_pool: true,
          })
          .select("id")
          .single(),
        "ms service acct2",
      );
      await ok(
        member2
          .from("recurring_service_occurrences")
          .insert({
            recurring_service_id: (service as { id: string }).id,
            period: "1998-09-01",
            amount: 20_000,
            currency: "CLP",
            status: "invoiced",
            invoice_due_date: "1998-09-10",
            collection_due_date: "1998-09-10",
            invoiced_at: "1998-09-02",
          })
          .select("id"),
        "ms occurrence acct2",
      );
      // The supplier invoice: 10.000 net + 1.900 IVA = 11.900. The pool takes the net.
      const pool = await ok(
        member2
          .from("recurring_service_cost_pools")
          .insert({ company_id: ids2.cl, service_type: "ms_licenses", period: "1998-09-01", total_expense_amount: 10_000, currency: "CLP" })
          .select("id")
          .single(),
        "pool acct2",
      );
      const split = await member2.rpc("allocate_recurring_service_cost_pool", { p_cost_pool_id: (pool as { id: string }).id });
      expect(split.error).toBeNull();
      expect(totalWithVat(10_000, "CL", 0)).toEqual({ rate: 0.19, vat: 1_900, total: 11_900 });

      // By hand: September = MS revenue 20.000 - its pool share 10.000 (net, never 11.900).
      const september = await computeMonthlyResult(ids2.cl, "1998-09-01");
      expect(september.recurringRevenue).toBe(20_000);
      expect(september.recurringCosts).toBe(10_000);
      expect(september.operatingResult).toBe(10_000);
    });
  });
  describe("3. Tipo de cambio guardado en cada documento", () => {
    const JUNE = "1997-06-01";
    let usdClient = "";

    it("cada documento guarda la tasa de su fecha y los reportes usan esa, aunque el snapshot cambie después", async () => {
      // June 1997: 1 USD = 40 UYU (USD per UYU = 25 / 1000).
      await ok(db.from("exchange_rate_snapshots").insert({ currency: "UYU", period: JUNE, ars_per_unit: 25, ars_per_usd: 1000 }).select("id"), "fx june 1997");
      const client = await ok(member2.from("clients").insert({ company_id: ids2.uy, name: `${PREFIX2}U1 ${tag}` }).select("id").single(), "client uy");
      usdClient = (client as { id: string }).id;
      const msArea = (await ok(
        db.from("business_areas").select("id").eq("company_id", ids2.uy).eq("name", "Microsoft 365").single(),
        "ms area uy",
      )) as { id: string };

      // A USD 100 invoice, a USD 10 MS cycle and a USD 4 MS pool, all of June.
      const saleId = await sale({ companyId: ids2.uy, clientId: usdClient, type: "invoice", number: `${PREFIX2}UF1-`, date: "1997-06-15", currency: "USD", net: 100, vat: 0.22, status: "por_vencer" });
      const service = await ok(
        member2
          .from("recurring_services")
          .insert({
            company_id: ids2.uy,
            client_id: usdClient,
            name: `${PREFIX2}MS-UY ${tag}`,
            price: 10,
            expected_cost: 0,
            currency: "USD",
            periodicity: "monthly",
            invoicing_mode: "advance",
            due_day: 10,
            start_date: "1997-01-01",
            end_date: "1997-12-31",
            status: "active",
            active: true,
            service_type: "ms_licenses",
            business_area_id: msArea.id,
            uses_cost_pool: true,
          })
          .select("id")
          .single(),
        "service uy",
      );
      const occurrence = await ok(
        member2
          .from("recurring_service_occurrences")
          .insert({ recurring_service_id: (service as { id: string }).id, period: JUNE, amount: 10, currency: "USD", status: "invoiced", invoice_due_date: "1997-06-10", collection_due_date: "1997-06-10", invoiced_at: "1997-06-02" })
          .select("id")
          .single(),
        "occurrence uy",
      );
      const pool = await ok(
        member2.from("recurring_service_cost_pools").insert({ company_id: ids2.uy, service_type: "ms_licenses", period: JUNE, total_expense_amount: 4, currency: "USD" }).select("id").single(),
        "pool uy",
      );
      const split = await member2.rpc("allocate_recurring_service_cost_pool", { p_cost_pool_id: (pool as { id: string }).id });
      expect(split.error).toBeNull();

      // The June snapshot is rewritten afterwards (as the live fetch of the
      // current month used to do): 1 USD = 50 UYU.
      await ok(db.from("exchange_rate_snapshots").update({ ars_per_unit: 20 }).eq("currency", "UYU").eq("period", JUNE).select("id"), "fx rewrite");

      // A USD 10 general cost of July: no July snapshot, so the nearest earlier one (as it is now).
      const { data: costRow, error: costError } = await member2.rpc("create_cost_document", {
        p_company_id: ids2.uy,
        p_supplier_id: null,
        p_project_id: null,
        p_classification: "general",
        p_document_date: "1997-07-10",
        p_currency: "USD",
        p_tax_amount: 2.2,
        p_lines: [{ description: `${PREFIX2}costo`, amount: 10 }],
      });
      if (costError) throw new Error(`cost uy: ${costError.message}`);

      const stored = async (table: string, id: string) =>
        (await ok(db.from(table).select("exchange_rate, exchange_rate_period").eq("id", id).single(), `stored ${table}`)) as {
          exchange_rate: number | null;
          exchange_rate_period: string | null;
        };
      const rates = {
        sale: await stored("sales_documents", saleId),
        occurrence: await stored("recurring_service_occurrences", (occurrence as { id: string }).id),
        pool: await stored("recurring_service_cost_pools", (pool as { id: string }).id),
        cost: await stored("cost_documents", (costRow as { id: string }).id),
      };
      report.acct2Rates = rates;
      expect(Object.values(rates).map((r) => [Number(r.exchange_rate), r.exchange_rate_period])).toEqual([
        [40, JUNE],
        [40, JUNE],
        [40, JUNE],
        [50, JUNE],
      ]);

      // By hand, June: sale 100 x 40 + cycle 10 x 40 = 4.400; pool 4 x 40 = 160.
      // July: cost 10 x 50 = 500. Never the rewritten 50 for June's documents.
      const [june, july, series] = await Promise.all([
        computeMonthlyResult(ids2.uy, JUNE),
        computeMonthlyResult(ids2.uy, "1997-07-01"),
        getMonthlySeries(ids2.uy, "1997-07-01", 2),
      ]);
      expect({ sales: june.netSales, direct: june.directCosts, pending: june.currencyConversionPending }).toEqual({ sales: 4_400, direct: 160, pending: false });
      expect({ general: july.generalCosts, pending: july.currencyConversionPending }).toEqual({ general: 500, pending: false });
      expect(series.map((p) => [p.netSales, p.directCosts, p.generalCosts])).toEqual([[4_400, 160, 0], [0, 0, 500]]);
      const breakdown = await getProfitabilityBreakdown(ids2.uy, JUNE);
      const row = breakdown.clients.find((c) => c.id === usdClient);
      expect({ revenue: row?.revenue, costs: row?.costs }).toEqual({ revenue: 4_400, costs: 160 });
    });

    it("solo el service role escribe la tabla de tipos de cambio", async () => {
      const insert = await member2.from("exchange_rate_snapshots").insert({ currency: "CLP", period: "1997-01-01", ars_per_unit: 1, ars_per_usd: 1 }).select("id");
      expect(insert.error).not.toBeNull();
      const update = await member2.from("exchange_rate_snapshots").update({ ars_per_unit: 1 }).eq("currency", "UYU").eq("period", JUNE).select("id");
      expect(update.error !== null || (update.data ?? []).length === 0).toBe(true);
      const june = (await ok(db.from("exchange_rate_snapshots").select("ars_per_unit").eq("currency", "UYU").eq("period", JUNE).single(), "fx june")) as { ars_per_unit: number };
      expect(Number(june.ars_per_unit)).toBe(20);
      // Reading stays open to members (the reports need it).
      const read = await member2.from("exchange_rate_snapshots").select("period").eq("period", JUNE);
      expect(read.error).toBeNull();
      expect((read.data ?? []).length).toBe(1);
    });
  });
});
