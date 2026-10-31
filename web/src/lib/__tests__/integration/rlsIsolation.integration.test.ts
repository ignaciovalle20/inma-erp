/**
 * Company isolation under RLS (rewritten in 20261030030000 with
 * is_company_member / is_company_admin and (select auth.uid())), against the
 * real inma-erp-dev project with two throwaway companies A and B, each with
 * its own admin, both signed in (RLS on):
 *
 * 1. B's member creates rows in B through the API (insert policies).
 * 2. A's member sees none of them, in any company-scoped table or child
 *    table, and cannot insert, update or delete anything in B.
 * 3. B's member sees its own rows; a signed-out client sees nothing.
 *
 * Run with `npm run test:integration`.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { anonClient, assertDevProject, serviceClient } from "./devProject";

const tag = `TEST_RLS ${randomUUID().slice(0, 6)}`;
const db = serviceClient();

// Every public table with a company_id column (pg catalog, 2026-10-30).
const COMPANY_TABLES = [
  "business_areas", "client_aliases", "clients", "company_memberships", "cost_documents", "cost_import_batches",
  "cost_service_allocations", "import_batches", "mcp_pending_drafts", "personnel", "project_checklist_items",
  "project_notes", "project_quotes", "projects", "recurring_service_cost_periods", "recurring_service_cost_pools",
  "recurring_services", "sales_allocations", "sales_documents", "suppliers", "technician_charge_documents",
  "technician_charges", "technician_document_suggestions", "technician_payment_applications", "technician_payments",
  "technician_suppliers",
];

type Side = { company: string; user: string; client: SupabaseClient };
const a = {} as Side;
const b = {} as Side;
const seeded = { client: "", supplier: "", project: "", sale: "", cost: "" };

async function ok<T = unknown>(p: PromiseLike<{ data: unknown; error: unknown }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(JSON.stringify(error));
  return data as T;
}

async function makeSide(side: Side, name: string) {
  side.company = (await ok<{ id: string }>(db.from("companies").insert({ name: `${tag} ${name}`, country: "CL", currency: "CLP" }).select("id").single())).id;
  const email = `test_rls_${name.toLowerCase()}_${randomUUID().slice(0, 6)}@example.test`;
  const password = randomBytes(24).toString("base64url");
  const { data, error } = await db.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  side.user = data.user.id;
  await ok(db.from("company_memberships").insert({ user_id: side.user, company_id: side.company, role: "admin" }).select("id"));
  side.client = anonClient();
  const { error: signInError } = await side.client.auth.signInWithPassword({ email, password });
  if (signInError) throw signInError;
}

beforeAll(async () => {
  assertDevProject();
  await makeSide(a, "A");
  await makeSide(b, "B");

  // B's own member creates B's data: the insert policies let it.
  const m = b.client;
  seeded.client = (await ok<{ id: string }>(m.from("clients").insert({ company_id: b.company, name: `${tag} Cliente B` }).select("id").single())).id;
  seeded.supplier = (await ok<{ id: string }>(m.from("suppliers").insert({ company_id: b.company, name: `${tag} Proveedor B` }).select("id").single())).id;
  const area = (await ok<{ id: string }[]>(m.from("business_areas").select("id").eq("company_id", b.company).limit(1)))[0];
  seeded.project = (
    await ok<{ id: string }>(
      m.from("projects").insert({ company_id: b.company, client_id: seeded.client, business_area_id: area.id, name: `${tag} Trabajo B` }).select("id").single(),
    )
  ).id;
  seeded.sale = (
    await ok<{ id: string }>(
      m.from("sales_documents").insert({
        company_id: b.company, client_id: seeded.client, document_type: "manual", document_date: "2026-08-14",
        currency: "CLP", net_amount: 1000, tax_amount: 190, total_amount: 1190,
      }).select("id").single(),
    )
  ).id;
  await ok(m.from("sales_lines").insert({ sales_document_id: seeded.sale, amount: 1000 }).select("id"));
  seeded.cost = (
    await ok<{ id: string }>(
      m.from("cost_documents").insert({
        company_id: b.company, supplier_id: seeded.supplier, classification: "general", document_date: "2026-08-14",
        currency: "CLP", net_amount: 500, tax_amount: 95, total_amount: 595,
      }).select("id").single(),
    )
  ).id;
  await ok(m.from("cost_lines").insert({ cost_document_id: seeded.cost, amount: 500 }).select("id"));
}, 180_000);

afterAll(async () => {
  const failures: unknown[] = [];
  const step = async (p: PromiseLike<{ error: unknown }>) => {
    const { error } = await p;
    if (error) failures.push(error);
  };
  for (const side of [a, b]) {
    if (!side.company) continue;
    const costs = ((await db.from("cost_documents").select("id").eq("company_id", side.company)).data ?? []).map((r) => r.id);
    const sales = ((await db.from("sales_documents").select("id").eq("company_id", side.company)).data ?? []).map((r) => r.id);
    if (costs.length) await step(db.from("cost_lines").delete().in("cost_document_id", costs));
    if (sales.length) await step(db.from("sales_lines").delete().in("sales_document_id", sales));
    await step(db.from("cost_documents").delete().eq("company_id", side.company));
    await step(db.from("sales_documents").delete().eq("company_id", side.company));
    await step(db.from("projects").delete().eq("company_id", side.company));
    await step(db.from("clients").delete().eq("company_id", side.company));
    await step(db.from("suppliers").delete().eq("company_id", side.company));
    await step(db.from("company_memberships").delete().eq("company_id", side.company));
    await step(db.from("business_areas").delete().eq("company_id", side.company));
    await step(db.from("companies").delete().eq("id", side.company));
  }
  for (const side of [a, b]) {
    if (!side.user) continue;
    const { error } = await db.auth.admin.deleteUser(side.user);
    if (error) failures.push(error);
  }
  if (failures.length) throw new Error(`cleanup failed (${tag}): ${JSON.stringify(failures)}`);
}, 180_000);

describe("RLS: one company never sees another's data", () => {
  it("A's member sees no row of B in any company-scoped table", async () => {
    const seen: Record<string, number> = {};
    for (const table of COMPANY_TABLES) {
      const rows = await ok<unknown[]>(a.client.from(table).select("company_id").eq("company_id", b.company));
      seen[table] = rows.length;
    }
    expect(Object.entries(seen).filter(([, n]) => n > 0)).toEqual([]);

    const companies = await ok<{ id: string }[]>(a.client.from("companies").select("id"));
    expect(companies.map((c) => c.id)).toEqual([a.company]);
  });

  it("A's member sees none of B's child rows (lines of B's documents)", async () => {
    expect(await ok<unknown[]>(a.client.from("sales_lines").select("id").eq("sales_document_id", seeded.sale))).toEqual([]);
    expect(await ok<unknown[]>(a.client.from("cost_lines").select("id").eq("cost_document_id", seeded.cost))).toEqual([]);
  });

  it("A's member cannot write into B", async () => {
    const insert = await a.client.from("clients").insert({ company_id: b.company, name: `${tag} intruso` }).select("id");
    expect(insert.error).not.toBeNull();

    const update = await ok<unknown[]>(a.client.from("clients").update({ name: `${tag} cambiado` }).eq("id", seeded.client).select("id"));
    expect(update).toEqual([]);
    const line = await a.client.from("cost_lines").insert({ cost_document_id: seeded.cost, amount: 1 }).select("id");
    expect(line.error).not.toBeNull();

    const still = await ok<{ name: string }>(db.from("clients").select("name").eq("id", seeded.client).single());
    expect(still.name).toBe(`${tag} Cliente B`);
  });

  it("B's member sees its own rows; a signed-out client sees nothing", async () => {
    for (const [table, id] of [
      ["clients", seeded.client], ["suppliers", seeded.supplier], ["projects", seeded.project],
      ["sales_documents", seeded.sale], ["cost_documents", seeded.cost],
    ] as const) {
      expect(await ok<unknown[]>(b.client.from(table).select("id").eq("id", id))).toHaveLength(1);
    }
    expect(await ok<unknown[]>(b.client.from("cost_lines").select("id").eq("cost_document_id", seeded.cost))).toHaveLength(1);

    const anon = anonClient();
    for (const table of ["companies", "clients", "sales_documents", "cost_documents"]) {
      // Empty, or refused outright where anon has no table privilege at all.
      const { data, error } = await anon.from(table).select("id").limit(5);
      expect(error ? [] : data).toEqual([]);
    }
  });
});
