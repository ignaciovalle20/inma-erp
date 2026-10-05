/**
 * Servicios recurrentes: ciclos retroactivos desde el inicio, acción masiva
 * con deshacer y vínculo automático con las facturas ya importadas
 * (migration 20261005010000), end to end against inma-erp-dev: the real
 * server actions, RPCs and profitability report, run as a signed-in
 * member of a throwaway Chile company. Everything is deleted in afterAll.
 * Run with `npm run test:integration`.
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
import { updateRecurringService } from "@/app/companies/[id]/recurring-services/services/[recurringServiceId]/edit/actions";
import {
  bulkMarkOccurrences,
  dismissOccurrenceLinkReview,
  resolveOccurrenceLink,
  undoBulkMarkOccurrences,
  voidOccurrencesBeforeStart,
} from "@/app/companies/[id]/recurring-services/occurrence-actions";
import { getProfitabilityBreakdown } from "@/lib/reporting";
import { cyclesBeforeStart, shiftMonth, todayForCountry } from "@/lib/recurringServicePending";

const tag = `zz-test-retro-${randomUUID().slice(0, 8)}`;
const currentMonth = todayForCountry("CL").slice(0, 7);

const ids = {
  company: "",
  clients: {} as Record<string, string>,
  services: {} as Record<string, string>,
  documents: [] as string[],
  user: "",
};

type Cycle = {
  id: string;
  period: string;
  status: string;
  invoice_due_date: string | null;
  collection_due_date: string | null;
  invoiced_at: string | null;
  collected_at: string | null;
  sales_document_id: string | null;
  link_review: string | null;
  amount: number;
};

/** Months "YYYY-MM" from `from` through `to`, inclusive. */
function monthsBetween(from: string, to: string): string[] {
  const months: string[] = [];
  for (let m = from; m <= to; m = shiftMonth(m, 1)) months.push(m);
  return months;
}

async function cyclesOf(key: string): Promise<Cycle[]> {
  const { data, error } = await serviceClient()
    .from("recurring_service_occurrences")
    .select(
      "id, period, status, invoice_due_date, collection_due_date, invoiced_at, collected_at, sales_document_id, link_review, amount",
    )
    .eq("recurring_service_id", ids.services[key])
    .order("period");
  if (error) throw error;
  return data as Cycle[];
}

async function addClient(key: string) {
  const { data, error } = await serviceClient()
    .from("clients")
    .insert({ company_id: ids.company, name: `${tag} ${key}` })
    .select("id")
    .single();
  if (error) throw error;
  ids.clients[key] = data.id;
}

/** Creates a service through the real action; returns where it redirected. */
async function create(
  key: string,
  client: string,
  fields: Record<string, string>,
): Promise<string> {
  const form = new FormData();
  form.set("client_id", ids.clients[client]);
  form.set("name", `${tag} ${key}`);
  form.set("price", "100000");
  form.set("periodicity", "monthly");
  form.set("invoicing_mode", "advance");
  form.set("due_day", "5");
  form.set("service_type", "hosting");
  form.set("requires_invoice", "on");
  for (const [name, value] of Object.entries(fields)) form.set(name, value);

  try {
    const result = await createRecurringService(
      ids.company,
      { error: null, values: {} } as unknown as Parameters<typeof createRecurringService>[1],
      form,
    );
    throw new Error(`create ${key} did not redirect: ${result.error}`);
  } catch (error) {
    const url = (error as { url?: string }).url;
    if (!url) throw error;
    const match = url.match(/services\/([0-9a-f-]{36})/);
    ids.services[key] = match![1];
    return url;
  }
}

async function addInvoice(client: string, documentDate: string, net: number, paid: boolean) {
  const { data, error } = await serviceClient()
    .from("sales_documents")
    .insert({
      company_id: ids.company,
      client_id: ids.clients[client],
      document_type: "invoice",
      document_number: `${tag}-${ids.documents.length + 1}`,
      document_date: documentDate,
      currency: "CLP",
      net_amount: net,
      tax_amount: Math.round(net * 0.19),
      total_amount: net + Math.round(net * 0.19),
      payment_status: paid ? "pagado" : "por_vencer",
      paid_at: paid ? documentDate : null,
      source: "import",
    })
    .select("id")
    .single();
  if (error) throw error;
  ids.documents.push(data.id);
  return data.id as string;
}

beforeAll(async () => {
  assertDevProject();
  const db = serviceClient();

  const { data: company, error } = await db
    .from("companies")
    .insert({ name: tag, country: "CL", currency: "CLP" })
    .select("id")
    .single();
  if (error) throw error;
  ids.company = company.id;

  for (const key of ["monthly", "annual", "old", "edit", "bulk", "match"]) await addClient(key);

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

  if (ids.company) {
    const { data: services } = await db.from("recurring_services").select("id").eq("company_id", ids.company);
    const serviceIds = (services ?? []).map((s) => s.id);
    if (serviceIds.length > 0) {
      const { data: occurrences } = await db
        .from("recurring_service_occurrences")
        .select("id")
        .in("recurring_service_id", serviceIds);
      const occurrenceIds = (occurrences ?? []).map((o) => o.id);
      if (occurrenceIds.length > 0) {
        await step(db.from("recurring_service_occurrence_bulk_changes").delete().in("occurrence_id", occurrenceIds));
      }
      await step(db.from("recurring_service_occurrences").delete().in("recurring_service_id", serviceIds));
      await step(db.from("recurring_services").delete().in("id", serviceIds));
    }
    if (ids.documents.length > 0) await step(db.from("sales_documents").delete().in("id", ids.documents));
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

describe("generación retroactiva al crear un servicio", () => {
  it("mensual con inicio 2026-03: un ciclo por mes de marzo al mes actual", async () => {
    const url = await create("monthly", "monthly", { start_date: "2026-03-01" });
    const expected = monthsBetween("2026-03", currentMonth);

    const cycles = await cyclesOf("monthly");
    expect(cycles.map((c) => c.period.slice(0, 7))).toEqual(expected);
    expect(cycles.every((c) => c.status === "pending_invoice")).toBe(true);
    expect(url).toContain(`ciclos=${expected.length}`);
  });

  it("anual con vencimiento en junio e inicio 2025: el ciclo de junio 2026, nada de 2025", async () => {
    await create("annual", "annual", {
      start_date: "2025-01-01",
      periodicity: "annual",
      due_month: "6",
      due_day: "15",
    });
    const cycles = await cyclesOf("annual");
    expect(cycles[0]).toMatchObject({ period: "2026-01-01", invoice_due_date: "2026-06-15" });
    expect(cycles.every((c) => c.period >= "2026-01-01")).toBe(true);
  });

  it("inicio 2024: arranca en enero 2026", async () => {
    await create("old", "old", { start_date: "2024-03-01" });
    const cycles = await cyclesOf("old");
    expect(cycles[0].period).toBe("2026-01-01");
    expect(cycles.map((c) => c.period.slice(0, 7))).toEqual(monthsBetween("2026-01", currentMonth));
  });

  it("re-generar no duplica ni toca los ciclos existentes", async () => {
    const before = await cyclesOf("monthly");
    // Mark one collected by hand: re-generating must leave it as it is.
    await serviceClient()
      .from("recurring_service_occurrences")
      .update({ status: "collected", collected_at: "2026-03-20", note: "a mano" })
      .eq("id", before[0].id);

    for (let i = 0; i < 2; i++) {
      const { data, error } = await memberClient!.rpc("generate_recurring_service_occurrences_since_start", {
        p_service_id: ids.services.monthly,
        p_until: `${currentMonth}-01`,
      });
      expect(error).toBeNull();
      expect(data).toEqual([]);
    }

    const after = await cyclesOf("monthly");
    expect(after.map((c) => c.id)).toEqual(before.map((c) => c.id));
    expect(after[0]).toMatchObject({ status: "collected", collected_at: "2026-03-20" });
  });
});

describe("mover la fecha de inicio", () => {
  it("hacia atrás genera lo que falta; hacia adelante no borra nada y ofrece anular lo sin cobrar", async () => {
    await create("edit", "edit", { start_date: "2026-08-01" });
    expect((await cyclesOf("edit"))[0].period).toBe("2026-08-01");

    const edit = async (startDate: string) => {
      const form = new FormData();
      form.set("client_id", ids.clients.edit);
      form.set("name", `${tag} edit`);
      form.set("price", "100000");
      form.set("currency", "CLP");
      form.set("periodicity", "monthly");
      form.set("invoicing_mode", "advance");
      form.set("due_day", "5");
      form.set("service_type", "hosting");
      form.set("requires_invoice", "on");
      form.set("status", "active");
      form.set("start_date", startDate);
      try {
        await updateRecurringService(ids.company, ids.services.edit, { error: null }, form);
      } catch (error) {
        if ((error as Error).message !== "NEXT_REDIRECT") throw error;
        return (error as { url: string }).url;
      }
      throw new Error("edit did not redirect");
    };

    // Backwards: April..July appear.
    const url = await edit("2026-04-01");
    expect(url).toContain("ciclos=4");
    expect((await cyclesOf("edit"))[0].period).toBe("2026-04-01");

    // Collect April, then move the start forward to June.
    const april = (await cyclesOf("edit"))[0];
    await serviceClient()
      .from("recurring_service_occurrences")
      .update({ status: "collected", collected_at: "2026-04-05" })
      .eq("id", april.id);
    await edit("2026-06-01");

    const cycles = await cyclesOf("edit");
    expect(cycles[0].period).toBe("2026-04-01"); // nothing deleted
    const before = cyclesBeforeStart(cycles, "2026-06-01", "monthly");
    expect(before.all.map((c) => c.period)).toEqual(["2026-04-01", "2026-05-01"]);
    expect(before.open.map((c) => c.period)).toEqual(["2026-05-01"]);

    expect(await voidOccurrencesBeforeStart(ids.company, ids.services.edit)).toEqual({ error: null, voided: 1 });
    const statuses = Object.fromEntries((await cyclesOf("edit")).map((c) => [c.period, c.status]));
    expect(statuses["2026-04-01"]).toBe("collected");
    expect(statuses["2026-05-01"]).toBe("void");
    expect(statuses["2026-06-01"]).toBe("pending_invoice");
  });
});

describe("marcar como facturado / cobrado hasta [mes], con deshacer", () => {
  it("cobra hasta mayo con la fecha de vencimiento de cada ciclo y lo deshace", async () => {
    await create("bulk", "bulk", { start_date: "2026-03-01" });
    const before = await cyclesOf("bulk");

    const result = await bulkMarkOccurrences(ids.company, ids.services.bulk, "2026-05", "collect");
    expect(result).toMatchObject({ error: null, changed: 3 });

    const after = await cyclesOf("bulk");
    for (const cycle of after) {
      if (cycle.period <= "2026-05-01") {
        expect(cycle).toMatchObject({ status: "collected", collected_at: cycle.invoice_due_date });
      } else {
        expect(cycle.status).toBe("pending_invoice");
      }
    }

    expect(await undoBulkMarkOccurrences(ids.company, ids.services.bulk, result.batchId!)).toEqual({
      error: null,
      restored: 3,
    });
    const restored = await cyclesOf("bulk");
    expect(restored.map((c) => [c.status, c.invoiced_at, c.collected_at])).toEqual(
      before.map((c) => [c.status, c.invoiced_at, c.collected_at]),
    );
  });

  it("factura hasta abril; un ciclo que cambió después no se toca al deshacer", async () => {
    const result = await bulkMarkOccurrences(ids.company, ids.services.bulk, "2026-04", "invoice");
    expect(result.changed).toBe(2);
    const [march] = await cyclesOf("bulk");
    expect(march).toMatchObject({ status: "invoiced", invoiced_at: march.invoice_due_date });

    // March gets collected afterwards: the undo leaves it alone.
    await serviceClient()
      .from("recurring_service_occurrences")
      .update({ status: "collected", collected_at: "2026-03-30" })
      .eq("id", march.id);
    expect((await undoBulkMarkOccurrences(ids.company, ids.services.bulk, result.batchId!)).restored).toBe(1);

    const [m, a] = await cyclesOf("bulk");
    expect(m.status).toBe("collected");
    expect(a).toMatchObject({ status: "pending_invoice", invoiced_at: null });
  });
});

describe("vínculo con facturas ya importadas (sin doble ingreso)", () => {
  let julyInvoice = "";
  let septemberInvoices: string[] = [];

  beforeAll(async () => {
    // 100.000 CLP/mes, mes adelantado desde julio. Facturas del mismo cliente:
    julyInvoice = await addInvoice("match", "2026-07-08", 101_000, true); // +1%: 1 match, pagada
    // agosto: ninguna
    septemberInvoices = [
      await addInvoice("match", "2026-09-03", 100_000, false), // dos candidatas
      await addInvoice("match", "2026-09-20", 99_000, false),
    ];
    await addInvoice("match", "2026-10-02", 100_000, false); // 1 match, sin pagar
    await addInvoice("match", "2026-06-10", 100_000, true); // junio: fuera de vigencia
    await addInvoice("match", "2026-07-15", 103_000, true); // +3%: fuera del margen

    await create("match", "match", { start_date: "2026-07-01" });
  });

  it("1 match -> vinculada y con el estado del cobro de Nubox; 0 o varios -> revisar vínculo", async () => {
    const byMonth = Object.fromEntries((await cyclesOf("match")).map((c) => [c.period.slice(0, 7), c]));

    expect(byMonth["2026-07"]).toMatchObject({
      sales_document_id: julyInvoice,
      status: "collected",
      collected_at: "2026-07-08",
      invoiced_at: "2026-07-08",
      link_review: null,
    });
    expect(byMonth["2026-08"]).toMatchObject({ sales_document_id: null, status: "pending_invoice", link_review: "no_match" });
    expect(byMonth["2026-09"]).toMatchObject({ sales_document_id: null, status: "pending_invoice", link_review: "multiple" });
    if (currentMonth >= "2026-10") {
      expect(byMonth["2026-10"]).toMatchObject({ status: "invoiced", invoiced_at: "2026-10-02", link_review: null });
    }
  });

  it("a mano: vincular resuelve el 'varios'; 'no tiene factura' no se vuelve a marcar", async () => {
    const byMonth = Object.fromEntries((await cyclesOf("match")).map((c) => [c.period.slice(0, 7), c]));

    expect(await resolveOccurrenceLink(ids.company, byMonth["2026-09"].id, septemberInvoices[0])).toEqual({ error: null });
    expect(await dismissOccurrenceLinkReview(ids.company, byMonth["2026-08"].id)).toEqual({ error: null });

    const { error } = await memberClient!.rpc("match_recurring_service_occurrences_to_invoices", {
      p_company_id: ids.company,
      p_service_id: ids.services.match,
      p_until: `${currentMonth}-01`,
    });
    expect(error).toBeNull();

    const after = Object.fromEntries((await cyclesOf("match")).map((c) => [c.period.slice(0, 7), c]));
    expect(after["2026-09"]).toMatchObject({
      sales_document_id: septemberInvoices[0],
      status: "invoiced",
      link_review: null,
    });
    expect(after["2026-08"]).toMatchObject({ sales_document_id: null, link_review: "dismissed" });
  });

  it("la rentabilidad de julio cuenta el ingreso UNA sola vez (factura + ciclo vinculado)", async () => {
    const report = await getProfitabilityBreakdown(ids.company, "2026-07-01");
    expect(report.hasError, JSON.stringify(report.errors)).toBe(false);
    const row = report.clients.find((c) => c.id === ids.clients.match);
    // The two July invoices (101.000 linked + 103.000 not a match), never
    // plus the collected 100.000 cycle on top.
    expect(row?.revenue).toBe(101_000 + 103_000);
  });
});
