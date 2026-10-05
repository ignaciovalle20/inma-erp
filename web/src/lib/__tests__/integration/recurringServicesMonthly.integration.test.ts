/**
 * Servicios recurrentes, país/moneda automáticos y ciclos mes a mes
 * (docs/servicios-recurrentes-cambios.md), end to end against the real
 * inma-erp-dev project: the actual server actions and DAL, run as a real
 * signed-in member of two throwaway companies (one Chile, one Uruguay),
 * so the DB triggers, RLS and the generator are all exercised. Run with
 * `npm run test:integration`. Every fixture is deleted in afterAll.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { anonClient, assertDevProject, serviceClient } from "./devProject";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { url });
  },
}));

let memberClient: SupabaseClient | null = null;
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    if (!memberClient) throw new Error("member client not ready");
    return memberClient;
  },
}));

import { createRecurringService } from "@/app/companies/[id]/recurring-services/services/new/actions";
import {
  markOccurrenceCollected,
  markOccurrenceInvoiced,
  undoOccurrenceCollected,
  undoOccurrenceInvoiced,
} from "@/app/companies/[id]/recurring-services/occurrence-actions";
import {
  ensureRecurringServiceOccurrencesForMonth,
  getPendingRecurringServiceOccurrences,
  getRecurringServiceOccurrencesForMonth,
} from "@/lib/dal";

const tag = `zz-test-rsm-${randomUUID().slice(0, 8)}`;

const ids = {
  companies: {} as Record<"CL" | "UY", string>,
  clients: {} as Record<"CL" | "UY", string>,
  user: null as string | null,
};

const emptyState = { error: null, values: {} } as unknown as Parameters<typeof createRecurringService>[1];

function serviceForm(country: "CL" | "UY", name: string, currency?: string) {
  const form = new FormData();
  form.set("client_id", ids.clients[country]);
  form.set("name", `${tag} ${name}`);
  form.set("price", "1000");
  form.set("periodicity", "monthly");
  form.set("invoicing_mode", "advance");
  form.set("due_day", "5");
  form.set("service_type", "hosting");
  form.set("start_date", "2026-09-01");
  form.set("requires_invoice", "on");
  if (currency !== undefined) form.set("currency", currency);
  return form;
}

/** Runs the create action; returns its error, or null when it saved and redirected. */
async function create(country: "CL" | "UY", name: string, currency?: string): Promise<string | null> {
  try {
    const result = await createRecurringService(ids.companies[country], emptyState, serviceForm(country, name, currency));
    return result.error ?? "returned without redirect";
  } catch (error) {
    if ((error as Error).message === "NEXT_REDIRECT") return null;
    throw error;
  }
}

async function servicesOf(country: "CL" | "UY") {
  const { data, error } = await serviceClient()
    .from("recurring_services")
    .select("id, name, country, currency")
    .eq("company_id", ids.companies[country]);
  if (error) throw error;
  return data;
}

beforeAll(async () => {
  assertDevProject();
  const db = serviceClient();

  for (const [country, currency] of [
    ["CL", "CLP"],
    ["UY", "UYU"],
  ] as const) {
    const { data: company, error } = await db
      .from("companies")
      .insert({ name: `${tag} ${country}`, country, currency })
      .select("id")
      .single();
    if (error) throw error;
    ids.companies[country] = company.id;

    const { data: client, error: clientError } = await db
      .from("clients")
      .insert({ company_id: company.id, name: `${tag} client ${country}` })
      .select("id")
      .single();
    if (clientError) throw clientError;
    ids.clients[country] = client.id;
  }

  const email = `${tag}@example.test`;
  const password = randomBytes(24).toString("base64url");
  const { data: created, error: userError } = await db.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (userError) throw userError;
  ids.user = created.user.id;

  const { error: membershipError } = await db.from("company_memberships").insert([
    { user_id: created.user.id, company_id: ids.companies.CL, role: "admin" },
    { user_id: created.user.id, company_id: ids.companies.UY, role: "admin" },
  ]);
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

  const companyIds = Object.values(ids.companies);
  if (companyIds.length > 0) {
    const { data: services } = await db.from("recurring_services").select("id").in("company_id", companyIds);
    const serviceIds = (services ?? []).map((s) => s.id);
    if (serviceIds.length > 0) {
      await step(db.from("recurring_service_occurrences").delete().in("recurring_service_id", serviceIds));
      await step(db.from("recurring_services").delete().in("id", serviceIds));
    }
    await step(db.from("company_memberships").delete().in("company_id", companyIds));
    await step(db.from("clients").delete().in("company_id", companyIds));
    await step(db.from("business_areas").delete().in("company_id", companyIds));
    await step(db.from("companies").delete().in("id", companyIds));
  }
  if (ids.user) {
    const { error } = await db.auth.admin.deleteUser(ids.user);
    if (error) failures.push(error);
  }

  if (failures.length > 0) {
    throw new Error(`Fixture cleanup failed (tag ${tag}): ${JSON.stringify(failures)}`);
  }
});

describe("1. Chile: no country or currency asked, stored as CL / CLP", () => {
  it("saves with no currency sent, and forces CLP even if another one is sent", async () => {
    expect(await create("CL", "sin moneda")).toBeNull();
    expect(await create("CL", "manda USD", "USD")).toBeNull();

    const services = await servicesOf("CL");
    expect(services).toHaveLength(2);
    for (const service of services) {
      expect(service).toMatchObject({ country: "CL", currency: "CLP" });
    }
  });
});

describe("2. Uruguay: currency required, USD or UYU only", () => {
  it("refuses to save without a currency, or with CLP", async () => {
    expect(await create("UY", "sin moneda")).toMatch(/USD o UYU/);
    expect(await create("UY", "con CLP", "CLP")).toMatch(/USD o UYU/);
    expect(await servicesOf("UY")).toHaveLength(0);
  });

  it("saves with UYU or USD, country UY", async () => {
    expect(await create("UY", "en UYU", "UYU")).toBeNull();
    expect(await create("UY", "en USD", "USD")).toBeNull();
    const services = await servicesOf("UY");
    expect(services.map((s) => [s.country, s.currency]).sort()).toEqual([
      ["UY", "USD"],
      ["UY", "UYU"],
    ]);
  });

  it("the database refuses a Uruguay service in CLP even bypassing the app", async () => {
    const { error } = await serviceClient().from("recurring_services").insert({
      company_id: ids.companies.UY,
      client_id: ids.clients.UY,
      name: `${tag} directo CLP`,
      price: 1,
      currency: "CLP",
      periodicity: "monthly",
      start_date: "2026-09-01",
    });
    expect(error?.message).toMatch(/USD or UYU/);
  });
});

describe("4. Facturado -> Cobrado -> deshacer, reflected in Deuda", () => {
  it("walks one cycle through every state and back", async () => {
    const companyId = ids.companies.CL;
    expect(await ensureRecurringServiceOccurrencesForMonth(companyId, "2026-10")).toBeGreaterThan(0);

    const [cycle] = (await getRecurringServiceOccurrencesForMonth(companyId, "2026-10")).filter((o) =>
      o.service_name.endsWith("sin moneda"),
    );
    expect(cycle).toMatchObject({ status: "pending_invoice", period: "2026-10-01", invoice_due_date: "2026-10-05", currency: "CLP" });

    const debtStatus = async () =>
      (await getPendingRecurringServiceOccurrences(companyId)).find((o) => o.id === cycle.id)?.status ?? null;

    expect(await debtStatus()).toBe("pending_invoice");

    expect(await markOccurrenceInvoiced(companyId, cycle.id)).toEqual({ error: null });
    expect(await debtStatus()).toBe("invoiced");

    expect(await markOccurrenceCollected(companyId, cycle.id)).toEqual({ error: null });
    expect(await debtStatus()).toBeNull(); // collected: out of Deuda

    expect(await undoOccurrenceCollected(companyId, cycle.id)).toEqual({ error: null });
    expect(await debtStatus()).toBe("invoiced");

    expect(await undoOccurrenceInvoiced(companyId, cycle.id)).toEqual({ error: null });
    expect(await debtStatus()).toBe("pending_invoice");

    const { data } = await serviceClient()
      .from("recurring_service_occurrences")
      .select("status, invoiced_at, collected_at, sales_document_id")
      .eq("id", cycle.id)
      .single();
    expect(data).toEqual({ status: "pending_invoice", invoiced_at: null, collected_at: null, sales_document_id: null });
  });
});

describe("5. Reopening a month never duplicates cycles", () => {
  it("running the generation twice for the same month creates nothing the second time", async () => {
    const companyId = ids.companies.UY;
    const first = await ensureRecurringServiceOccurrencesForMonth(companyId, "2026-11");
    const second = await ensureRecurringServiceOccurrencesForMonth(companyId, "2026-11");
    expect(first).toBe(2);
    expect(second).toBe(0);

    const cycles = await getRecurringServiceOccurrencesForMonth(companyId, "2026-11");
    expect(cycles).toHaveLength(2);
    expect(cycles.map((c) => c.currency).sort()).toEqual(["USD", "UYU"]);
  });

  it("refuses months before September 2026", async () => {
    expect(await ensureRecurringServiceOccurrencesForMonth(ids.companies.UY, "2026-08")).toBe(0);
  });
});
