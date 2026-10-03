/**
 * QA fase 2b: copies of ten real recurring services loaded into two
 * TEST_QA companies (CL / UY) of inma-erp-dev through the real create
 * server action, signed in as a real member (so the country/currency
 * trigger, the UY currency validation, RLS and the generator are all
 * exercised), then the month boards, Deuda and the state actions are
 * checked against the expected Planner dates. Reference date: 3/10/2026.
 *
 * Unlike the rest of the suite this one KEEPS its data (the user browses
 * it afterwards), so it only runs when asked:
 *   QA_FASE2B=1 npx vitest run -c vitest.integration.config.ts qaFase2b
 * It is idempotent: companies, clients, user and services are reused
 * when they already exist; generation never duplicates.
 */
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { anonClient, assertDevProject, runLinkedSql, serviceClient } from "./devProject";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { url });
  },
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));

let memberClient: SupabaseClient | null = null;
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    if (!memberClient) throw new Error("member client not ready");
    return memberClient;
  },
}));

import { createRecurringService } from "@/app/companies/[id]/recurring-services/new/actions";
import {
  markOccurrenceCollected,
  markOccurrenceInvoiced,
} from "@/app/companies/[id]/recurring-services/pending/actions";
import { OccurrenceCard } from "@/app/companies/[id]/recurring-services/occurrence-card";
import {
  ensureRecurringServiceOccurrencesForMonth,
  getPendingRecurringServiceOccurrences,
  getRecurringServiceOccurrencesForMonth,
  type RecurringServiceOccurrenceRow,
} from "@/lib/dal";
import { isOpenStatus, isOverdue, splitByOverdue, todayForCountry, totalsByCurrency } from "@/lib/recurringServicePending";

const RUN = process.env.QA_FASE2B === "1";
const OUT = process.env.QA_OUT;
const TODAY = "2026-10-03";
const PREFIX = "TEST_QA";
const EMAIL = "test_qa_fase2b@example.test";

type Country = "CL" | "UY";
type Spec = {
  key: string;
  country: Country;
  client: string;
  type: "hosting" | "ms_licenses";
  name: string;
  periodicity: "monthly" | "annual";
  mode: "advance" | "arrears";
  dueDay: number;
  dueMonth?: number;
  price: number;
  currency?: "USD" | "UYU";
  notes?: string;
  requiresInvoice: boolean;
};

const SPECS: Spec[] = [
  { key: "terror", country: "CL", client: "Terror aventura", type: "hosting", name: "Terror aventura – Plan Medio", periodicity: "annual", mode: "advance", dueDay: 31, dueMonth: 5, price: 59900, notes: "Plan Medio - 59.900 + iva + dominio 1 año", requiresInvoice: true },
  { key: "numancia", country: "CL", client: "Colegio Numancia", type: "hosting", name: "Colegio Numancia – Plan Grande", periodicity: "annual", mode: "advance", dueDay: 30, dueMonth: 9, price: 50000, requiresInvoice: true },
  { key: "ivcb", country: "CL", client: "IVCB", type: "hosting", name: "IVCB – Plan Básico", periodicity: "annual", mode: "advance", dueDay: 26, dueMonth: 4, price: 50000, notes: "Facturar por plan basico. VCB INVERSIONES S.A. 77.108.223-8", requiresInvoice: true },
  { key: "razo", country: "CL", client: "Razo", type: "ms_licenses", name: "Microsoft 365 – Razo – mes adelantado", periodicity: "monthly", mode: "advance", dueDay: 10, price: 50000, notes: "23 STD / 3 XCH 2 / 10 XCH 1 / 2 PowerBI", requiresInvoice: true },
  { key: "zerbo", country: "UY", client: "Zerboinvest", type: "hosting", name: "zerboinvest.com – plan grande", periodicity: "annual", mode: "advance", dueDay: 31, dueMonth: 12, price: 100, currency: "USD", notes: "Contacto: Tomas Zerbini", requiresInvoice: false },
  { key: "happyyou", country: "UY", client: "Happy You", type: "hosting", name: "preservativoshappyyou.com.ar – plan medio – argentino", periodicity: "annual", mode: "advance", dueDay: 28, dueMonth: 2, price: 100, currency: "USD", notes: "cliente de chess", requiresInvoice: false },
  { key: "omega", country: "UY", client: "Omega21", type: "hosting", name: "omega21.com.uy – plan básico", periodicity: "annual", mode: "advance", dueDay: 30, dueMonth: 11, price: 2000, currency: "UYU", requiresInvoice: true },
  { key: "leon", country: "UY", client: "Leon Estufas", type: "hosting", name: "leonestufas.uy – plan básico", periodicity: "annual", mode: "advance", dueDay: 30, dueMonth: 6, price: 2000, currency: "UYU", notes: "+598 94 239 567", requiresInvoice: false },
  { key: "trimant", country: "UY", client: "Trimant", type: "ms_licenses", name: "Microsoft 365 – Trimant – mes vencido", periodicity: "monthly", mode: "arrears", dueDay: 5, price: 100, currency: "USD", requiresInvoice: true },
  { key: "fabian", country: "UY", client: "Fabian", type: "ms_licenses", name: "Microsoft 365 – Fabian – mes vencido", periodicity: "monthly", mode: "arrears", dueDay: 10, price: 100, currency: "USD", notes: "2 licencias STD", requiresInvoice: true },
];

const ids = {
  companies: {} as Record<Country, string>,
  clients: {} as Record<string, string>,
  services: {} as Record<string, string>,
};
const report: Record<string, unknown> = {};

const emptyState = { error: null, values: {} } as unknown as Parameters<typeof createRecurringService>[1];

function formFor(spec: Spec, currency: string | undefined) {
  const form = new FormData();
  form.set("client_id", ids.clients[spec.key]);
  form.set("name", spec.name);
  form.set("price", String(spec.price));
  form.set("periodicity", spec.periodicity);
  form.set("invoicing_mode", spec.mode);
  form.set("due_day", String(spec.dueDay));
  if (spec.dueMonth) form.set("due_month", String(spec.dueMonth));
  form.set("service_type", spec.type);
  // Copies of services that are already running.
  form.set("start_date", "2025-01-01");
  if (spec.requiresInvoice) form.set("requires_invoice", "on");
  if (spec.notes) form.set("notes", spec.notes);
  if (currency !== undefined) form.set("currency", currency);
  return form;
}

async function create(spec: Spec, currency: string | undefined): Promise<string | null> {
  try {
    const result = await createRecurringService(ids.companies[spec.country], emptyState, formFor(spec, currency));
    return result.error ?? "returned without redirect";
  } catch (error) {
    if ((error as Error).message === "NEXT_REDIRECT") return null;
    throw error;
  }
}

function keyOf(row: RecurringServiceOccurrenceRow) {
  return Object.entries(ids.services).find(([, id]) => id === row.recurring_service_id)?.[0] ?? row.service_name;
}

function describeRow(row: RecurringServiceOccurrenceRow, country: Country) {
  return {
    key: keyOf(row),
    period: row.period,
    due: row.invoice_due_date,
    status: row.status,
    amount: row.amount,
    currency: row.currency,
    overdue: isOverdue(row, todayForCountry(country)),
  };
}

async function board(country: Country, month: string) {
  const rows = await getRecurringServiceOccurrencesForMonth(ids.companies[country], month);
  const described = rows.map((r) => describeRow(r, country));
  report[`board ${month} ${country}`] = described;
  return { rows, described, keys: described.map((r) => r.key).sort() };
}

async function debt(country: Country) {
  const rows = await getPendingRecurringServiceOccurrences(ids.companies[country]);
  return rows.map((r) => describeRow(r, country));
}

async function generate(month: string) {
  const counts: Record<string, number | null> = {};
  for (const country of ["CL", "UY"] as const) {
    counts[country] = await ensureRecurringServiceOccurrencesForMonth(ids.companies[country], month);
  }
  const key = `generate ${month}`;
  report[key in report ? `re-${key}` : key] = counts;
  return counts;
}

async function findOrCreate<T extends { id: string }>(
  table: string,
  match: Record<string, string>,
  insert: Record<string, unknown>,
): Promise<string> {
  const db = serviceClient();
  let query = db.from(table).select("id");
  for (const [column, value] of Object.entries(match)) query = query.eq(column, value);
  const { data: found, error } = await query.maybeSingle<T>();
  if (error) throw error;
  if (found) return found.id;
  const { data: created, error: insertError } = await db.from(table).insert(insert).select("id").single<T>();
  if (insertError) throw insertError;
  return created.id;
}

beforeAll(async () => {
  if (!RUN) return;
  assertDevProject();
  const db = serviceClient();

  for (const [country, currency] of [
    ["CL", "CLP"],
    ["UY", "UYU"],
  ] as const) {
    const name = `${PREFIX} ${country}`;
    ids.companies[country] = await findOrCreate("companies", { name }, { name, country, currency });
  }
  for (const spec of SPECS) {
    const name = `${PREFIX} ${spec.client}`;
    const companyId = ids.companies[spec.country];
    ids.clients[spec.key] = await findOrCreate("clients", { company_id: companyId, name }, { company_id: companyId, name });
  }

  // A member user for the two companies; a fresh random password each run
  // (never printed), only used to sign in below.
  const password = randomBytes(24).toString("base64url");
  const { data: list, error: listError } = await db.auth.admin.listUsers({ perPage: 1000 });
  if (listError) throw listError;
  const existing = list.users.find((u) => u.email === EMAIL);
  let userId: string;
  if (existing) {
    const { error } = await db.auth.admin.updateUserById(existing.id, { password });
    if (error) throw error;
    userId = existing.id;
  } else {
    const { data, error } = await db.auth.admin.createUser({ email: EMAIL, password, email_confirm: true });
    if (error) throw error;
    userId = data.user.id;
  }
  for (const companyId of Object.values(ids.companies)) {
    await findOrCreate("company_memberships", { user_id: userId, company_id: companyId }, { user_id: userId, company_id: companyId, role: "admin" });
  }

  const client = anonClient();
  const { error: signInError } = await client.auth.signInWithPassword({ email: EMAIL, password });
  if (signInError) throw signInError;
  memberClient = client;
});

describe.skipIf(!RUN)("QA fase 2b", () => {
  it("creates the ten services through the server action (country/currency auto, UY currency required)", async () => {
    const results: Record<string, unknown> = {};
    for (const spec of SPECS) {
      const { data: existing } = await serviceClient()
        .from("recurring_services")
        .select("id")
        .eq("company_id", ids.companies[spec.country])
        .eq("name", spec.name)
        .maybeSingle();
      if (!existing) {
        if (spec.country === "UY") {
          // The form's empty placeholder: must be refused, nothing saved.
          const refused = await create(spec, undefined);
          expect(refused).toMatch(/USD o UYU/);
          results[`${spec.key} sin moneda`] = refused;
        }
        // Chile: the form sends no currency selector at all ("Chile · CLP").
        const error = await create(spec, spec.country === "UY" ? spec.currency : undefined);
        expect(error).toBeNull();
      }
    }

    const { data: services, error } = await serviceClient()
      .from("recurring_services")
      .select("id, name, country, currency, price, periodicity, invoicing_mode, due_day, due_month, requires_invoice, notes, service_type, company_id")
      .in("company_id", Object.values(ids.companies));
    if (error) throw error;
    expect(services).toHaveLength(SPECS.length);

    for (const spec of SPECS) {
      const service = services!.find((s) => s.name === spec.name)!;
      ids.services[spec.key] = service.id;
      expect(service).toMatchObject({
        company_id: ids.companies[spec.country],
        country: spec.country,
        currency: spec.country === "CL" ? "CLP" : spec.currency,
        requires_invoice: spec.requiresInvoice,
        invoicing_mode: spec.mode,
        due_day: spec.dueDay,
        due_month: spec.dueMonth ?? null,
        notes: spec.notes ?? null,
      });
    }
    report.services = services;
    report.createResults = results;
  });

  it("September 2026", async () => {
    await generate("2026-09");
    await generate("2026-10");

    const cl = await board("CL", "2026-09");
    expect(cl.keys).toEqual(["numancia", "razo"]);
    expect(cl.described.find((r) => r.key === "numancia")).toMatchObject({ status: "pending_invoice", due: "2026-09-30", overdue: true });
    // Overdue while open (a rerun finds it already collected by the Razo step below).
    const razoSep = cl.described.find((r) => r.key === "razo")!;
    expect(razoSep).toMatchObject({ due: "2026-09-10", overdue: isOpenStatus(razoSep.status) });

    const uy = await board("UY", "2026-09");
    expect(uy.keys).toEqual(["fabian", "trimant"]);
    expect(uy.described.find((r) => r.key === "trimant")).toMatchObject({ due: "2026-09-05", overdue: true });
    expect(uy.described.find((r) => r.key === "fabian")).toMatchObject({ due: "2026-09-10", overdue: true });
  });

  it("October 2026", async () => {
    const cl = await board("CL", "2026-10");
    expect(cl.keys).toEqual(["razo"]);
    expect(cl.described[0]).toMatchObject({ due: "2026-10-10" });
    const uy = await board("UY", "2026-10");
    expect(uy.keys).toEqual(["fabian", "trimant"]);
  });

  it("Deuda UY on 3/10 = Trimant and Fabian, Sept + Oct, in USD; Sept is Vencido, Oct is Por vencer", async () => {
    const rows = await getPendingRecurringServiceOccurrences(ids.companies.UY);
    const { overdue, upcoming } = splitByOverdue(rows, TODAY);
    const label = (list: RecurringServiceOccurrenceRow[]) => list.map((r) => `${keyOf(r)} ${r.invoice_due_date}`).sort();
    report["deuda UY vencido"] = label(overdue);
    report["deuda UY por vencer"] = label(upcoming);
    expect(label(overdue)).toEqual(["fabian 2026-09-10", "trimant 2026-09-05"]);
    // Por vencer also holds whatever later months were already opened
    // (a rerun has Nov/Dec); due by end of October it's exactly these.
    expect(label(upcoming.filter((r) => r.invoice_due_date! < "2026-11-01"))).toEqual([
      "fabian 2026-10-10",
      "trimant 2026-10-05",
    ]);
    expect(new Set(overdue.map((r) => r.currency))).toEqual(new Set(["USD"]));
    expect(totalsByCurrency(overdue)).toEqual([{ currency: "USD", toInvoice: 200, toCollect: 0, collected: 0 }]);
  });

  it("November and December 2026", async () => {
    await generate("2026-11");
    await generate("2026-12");

    const novUy = await board("UY", "2026-11");
    expect(novUy.keys).toEqual(["fabian", "omega", "trimant"]);
    expect(novUy.described.find((r) => r.key === "omega")).toMatchObject({ status: "pending_invoice", due: "2026-11-30", currency: "UYU" });
    // Totals: USD and UYU on separate rows, never added.
    const totals = totalsByCurrency(novUy.rows);
    report["totales nov UY"] = totals;
    expect(totals).toEqual([
      { currency: "USD", toInvoice: 200, toCollect: 0, collected: 0 },
      { currency: "UYU", toInvoice: 2000, toCollect: 0, collected: 0 },
    ]);
    expect((await board("CL", "2026-11")).keys).toEqual(["razo"]);

    const decUy = await board("UY", "2026-12");
    expect(decUy.keys).toEqual(["fabian", "trimant", "zerbo"]);
    expect(decUy.described.find((r) => r.key === "zerbo")).toMatchObject({ status: "pending_collection", due: "2026-12-31", currency: "USD" });
    expect((await board("CL", "2026-12")).keys).toEqual(["razo"]);
  });

  it("annuals due before September generate nothing in 2026; first cycles in 2027", async () => {
    const all = await getPendingRecurringServiceOccurrences(ids.companies.UY);
    const allCl = await getPendingRecurringServiceOccurrences(ids.companies.CL);
    const generated = new Set([...all, ...allCl].map(keyOf));
    for (const key of ["happyyou", "leon", "ivcb", "terror"]) expect(generated.has(key)).toBe(false);

    // 2027 in a rolled-back transaction: checks the generator without
    // leaving next year's cycles in the TEST_QA companies.
    const companies = Object.values(ids.companies).map((id) => `'${id}'`).join(",");
    const rows = runLinkedSql<{ name: string; period: string; due: string; status: string }>(
      `begin; create temp table qa_gen as select g.service_id, g.occurrence_period, m.month from generate_series(date '2027-01-01', date '2027-12-01', interval '1 month') m(month), unnest(array[${companies}]::uuid[]) c(id), lateral public.generate_recurring_service_occurrences_for_month(m.month::date, c.id) g; select rs.name, o.period::text, o.invoice_due_date::text as due, o.status from qa_gen q join public.recurring_services rs on rs.id = q.service_id join public.recurring_service_occurrences o on o.recurring_service_id = q.service_id and o.period = q.occurrence_period where rs.periodicity = 'annual' order by o.invoice_due_date; rollback;`,
    );
    report["anuales 2027 (transacción revertida)"] = rows;
    const firstDue = (name: string) => rows.find((r) => r.name === name)?.due;
    expect(firstDue("preservativoshappyyou.com.ar – plan medio – argentino")).toBe("2027-02-28");
    expect(firstDue("IVCB – Plan Básico")).toBe("2027-04-26");
    expect(firstDue("Terror aventura – Plan Medio")).toBe("2027-05-31");
    expect(firstDue("leonestufas.uy – plan básico")).toBe("2027-06-30");
  });

  it("cycles of services that don't require an invoice never offer Facturado, only Cobrado", async () => {
    const rows = (await getPendingRecurringServiceOccurrences(ids.companies.UY)).filter((r) => !r.service_requires_invoice);
    expect(rows.length).toBeGreaterThan(0);
    const render = (row: RecurringServiceOccurrenceRow) =>
      renderToString(createElement(OccurrenceCard, { companyId: ids.companies.UY, occurrence: row, today: TODAY, country: "UY" }));
    for (const row of rows) {
      expect(row.status).toBe("pending_collection");
      const html = render(row);
      expect(html).not.toMatch(/>Facturado</);
      expect(html).toMatch(/>Cobrado</);
      // The server refuses it too.
      expect((await markOccurrenceInvoiced(ids.companies.UY, row.id)).error).not.toBeNull();
    }
    // Control: a cycle that does require one shows Facturado.
    const control = (await getPendingRecurringServiceOccurrences(ids.companies.UY)).find((r) => r.status === "pending_invoice")!;
    expect(render(control)).toMatch(/>Facturado</);
  });

  it("Razo Sept: Facturado -> Cobrado leaves Deuda; Razo Oct stays pending", async () => {
    const companyId = ids.companies.CL;
    const razo = (await getRecurringServiceOccurrencesForMonth(companyId, "2026-09")).find((r) => keyOf(r) === "razo")!;
    if (razo.status === "pending_invoice") {
      expect(await markOccurrenceInvoiced(companyId, razo.id)).toEqual({ error: null });
    }
    if ((await getPendingRecurringServiceOccurrences(companyId)).find((r) => r.id === razo.id)?.status === "invoiced") {
      expect(await markOccurrenceCollected(companyId, razo.id)).toEqual({ error: null });
    }
    const pending = await debt("CL");
    report["deuda CL (tras cobrar Razo sep)"] = pending;
    expect(pending.find((r) => r.key === "razo" && r.period === "2026-09-01")).toBeUndefined();
    expect(pending.find((r) => r.key === "razo" && r.period === "2026-10-01")).toMatchObject({ status: "pending_invoice" });
  });

  it("running the generation again creates nothing", async () => {
    for (const month of ["2026-09", "2026-10", "2026-11", "2026-12"]) {
      expect(await generate(month)).toEqual({ CL: 0, UY: 0 });
    }
    report["deuda UY (final)"] = await debt("UY");
    report["deuda CL (final)"] = await debt("CL");
    report.ids = ids;

  });
});

afterAll(() => {
  if (RUN && OUT) writeFileSync(OUT, JSON.stringify(report, null, 2));
});
