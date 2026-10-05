/**
 * Profitability report (getProfitabilityBreakdown) x recurring services,
 * against the real inma-erp-dev project: an occurrence's sale lands in
 * the month it was actually invoiced, full amount -- including annual
 * services, whose `period` is January 1st of the year they bill. Run
 * with `npm run test:integration`.
 *
 * The report runs as a real signed-in member of a throwaway company, so
 * the actual PostgREST filters (and RLS) are exercised, not a fake.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { anonClient, assertDevProject, serviceClient } from "./devProject";

vi.mock("server-only", () => ({}));

let memberClient: SupabaseClient | null = null;
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    if (!memberClient) throw new Error("member client not ready");
    return memberClient;
  },
}));

import { getProfitabilityBreakdown } from "@/lib/reporting";

const tag = `zz-test-rep-${randomUUID().slice(0, 8)}`;
const YEAR = 2025;

// One client per case, so each case's revenue can be read on its own.
const cases = {
  // Annual, due in May, invoiced on time in May.
  annualMay: {
    due_month: 5,
    occurrence: { period: `${YEAR}-01-01`, status: "invoiced", invoice_due_date: `${YEAR}-05-10`, invoiced_at: `${YEAR}-05-12` },
    expectedMonth: 5,
  },
  // Annual, due in March but actually invoiced in April: April, not March.
  annualInvoicedLate: {
    due_month: 3,
    occurrence: { period: `${YEAR}-01-01`, status: "collected", invoice_due_date: `${YEAR}-03-10`, invoiced_at: `${YEAR}-04-02` },
    expectedMonth: 4,
  },
  // Annual loaded by hand already invoiced, no invoiced_at: its due month.
  annualNoInvoicedAt: {
    due_month: 8,
    occurrence: { period: `${YEAR}-01-01`, status: "invoiced", invoice_due_date: `${YEAR}-08-10`, invoiced_at: null },
    expectedMonth: 8,
  },
} as const;

const PRICE = 1200;

const ids = {
  company: null as string | null,
  clients: {} as Record<keyof typeof cases, string>,
  services: [] as string[],
  user: null as string | null,
};

beforeAll(async () => {
  assertDevProject();
  const db = serviceClient();

  const { data: company, error: companyError } = await db
    .from("companies")
    .insert({ name: tag, currency: "USD" })
    .select("id")
    .single();
  if (companyError) throw companyError;
  ids.company = company.id;

  for (const [key, c] of Object.entries(cases) as [keyof typeof cases, (typeof cases)[keyof typeof cases]][]) {
    const { data: client, error } = await db
      .from("clients")
      .insert({ company_id: company.id, name: `${tag} ${key}` })
      .select("id")
      .single();
    if (error) throw error;
    ids.clients[key] = client.id;

    const { data: service, error: serviceError } = await db
      .from("recurring_services")
      .insert({
        company_id: company.id,
        client_id: client.id,
        name: `${tag} ${key}`,
        price: PRICE,
        currency: "USD",
        periodicity: "annual",
        invoicing_mode: "advance",
        due_day: 10,
        due_month: c.due_month,
        start_date: "2020-01-01",
      })
      .select("id")
      .single();
    if (serviceError) throw serviceError;
    ids.services.push(service.id);

    const { error: occurrenceError } = await db.from("recurring_service_occurrences").insert({
      recurring_service_id: service.id,
      amount: PRICE,
      currency: "USD",
      collection_due_date: c.occurrence.invoice_due_date,
      ...c.occurrence,
    });
    if (occurrenceError) throw occurrenceError;
  }

  // A real member of the company, signed in -- the report runs as them.
  const email = `${tag}@example.test`;
  const password = randomBytes(24).toString("base64url");
  const { data: created, error: userError } = await db.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (userError) throw userError;
  ids.user = created.user.id;

  const { error: membershipError } = await db
    .from("company_memberships")
    .insert({ user_id: created.user.id, company_id: company.id, role: "admin" });
  if (membershipError) throw membershipError;

  const client = anonClient();
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw signInError;
  memberClient = client;
});

afterAll(async () => {
  const db = serviceClient();
  const failures: unknown[] = [];
  const step = async (p: PromiseLike<{ error: unknown }>) => {
    const { error } = await p;
    if (error) failures.push(error);
  };

  if (ids.services.length > 0) {
    await step(db.from("recurring_service_occurrences").delete().in("recurring_service_id", ids.services));
    await step(db.from("recurring_services").delete().in("id", ids.services));
  }
  if (ids.company) {
    await step(db.from("company_memberships").delete().eq("company_id", ids.company));
    await step(db.from("clients").delete().eq("company_id", ids.company));
    await step(db.from("business_areas").delete().eq("company_id", ids.company));
    await step(db.from("companies").delete().eq("id", ids.company));
  }
  if (ids.user) {
    const { error } = await db.auth.admin.deleteUser(ids.user);
    if (error) failures.push(error);
  }

  if (failures.length > 0) {
    throw new Error(`Fixture cleanup failed (tag ${tag}): ${JSON.stringify(failures)}`);
  }
});

describe("profitability report: recurring-service sales land in the month they were invoiced", () => {
  // revenue per case key, per month 1..12
  const revenueByMonth: Record<string, number[]> = {};

  beforeAll(async () => {
    for (const key of Object.keys(cases)) revenueByMonth[key] = [];
    for (let month = 1; month <= 12; month++) {
      const report = await getProfitabilityBreakdown(
        ids.company!,
        `${YEAR}-${String(month).padStart(2, "0")}-01`,
      );
      expect(report.hasError, JSON.stringify(report.errors)).toBe(false);
      for (const key of Object.keys(cases) as (keyof typeof cases)[]) {
        const row = report.clients.find((c) => c.id === ids.clients[key]);
        revenueByMonth[key][month] = row?.revenue ?? Number.NaN;
      }
    }
  });

  it.each(Object.entries(cases))("%s: full amount in its real month and in no other", (key, c) => {
    for (let month = 1; month <= 12; month++) {
      expect(revenueByMonth[key][month], `${key}, month ${month}`).toBe(
        month === c.expectedMonth ? PRICE : 0,
      );
    }
  });
});
