/**
 * Search of documents over the whole history (20261031040000), against the real
 * inma-erp-dev project, as a signed-in member (RLS on): by folio, type + folio,
 * supplier or client, RUT, job and line; any month; one page and the total; and
 * nothing of another company.
 *
 * Run with `npm run test:integration`.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { anonClient, assertDevProject, serviceClient } from "./devProject";

const tag = `TEST_SEARCH ${randomUUID().slice(0, 6)}`;
const unique = tag.replace(/\W/g, "").toLowerCase();
const db = serviceClient();
const ids = { company: "", other: "", user: "", supplier: "", client: "", project: "" };
const docs: Record<string, string> = {};
let member: SupabaseClient;

async function ok<T = unknown>(p: PromiseLike<{ data: unknown; error: unknown }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(JSON.stringify(error));
  return data as T;
}

type Row = { id: string; total_count: number };

const searchCosts = (query: string, extra: Record<string, unknown> = {}, company = ids.company) =>
  ok<Row[]>(member.rpc("search_cost_documents", { p_company_id: company, p_query: query, ...extra }));

async function addCost(date: string, type: string | null, number: string | null, net: number, description: string) {
  const row = await ok<{ id: string }>(
    db
      .from("cost_documents")
      .insert({
        company_id: ids.company,
        supplier_id: ids.supplier,
        classification: "general",
        document_date: date,
        currency: "CLP",
        net_amount: net,
        tax_amount: 0,
        total_amount: net,
        source_document_type: type,
        document_number: number,
        source: "manual",
        status: "confirmed",
      })
      .select("id")
      .single(),
  );
  await ok(db.from("cost_lines").insert({ cost_document_id: row.id, description, amount: net }).select("id"));
  return row.id;
}

beforeAll(async () => {
  assertDevProject();
  for (const key of ["company", "other"] as const) {
    const company = await ok<{ id: string }>(
      db.from("companies").insert({ name: `${tag} ${key}`, country: "CL", currency: "CLP" }).select("id").single(),
    );
    ids[key] = company.id;
  }
  const email = `test_search_${randomUUID().slice(0, 6)}@example.test`;
  const password = randomBytes(24).toString("base64url");
  const { data: user, error } = await db.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  ids.user = user.user.id;
  await ok(db.from("company_memberships").insert({ user_id: ids.user, company_id: ids.company, role: "admin" }).select("id"));
  member = anonClient();
  const { error: signInError } = await member.auth.signInWithPassword({ email, password });
  if (signInError) throw signInError;

  const supplier = await ok<{ id: string }>(
    db.from("suppliers").insert({ company_id: ids.company, name: `Ferretería ${unique}`, tax_id: "11222333-4" }).select("id").single(),
  );
  ids.supplier = supplier.id;
  const client = await ok<{ id: string }>(
    db.from("clients").insert({ company_id: ids.company, name: `Cliente ${unique}`, tax_id: "55666777-8" }).select("id").single(),
  );
  ids.client = client.id;
  const area = await ok<{ id: string }>(db.from("business_areas").select("id").eq("company_id", ids.company).limit(1).single());
  const project = await ok<{ id: string }>(
    db.from("projects").insert({ company_id: ids.company, client_id: client.id, business_area_id: area.id, name: `Obra ${unique}`, status: "en_ejecucion" }).select("id").single(),
  );
  ids.project = project.id;

  docs.old = await addCost("2021-03-05", "BOL-HE", "156", 589970, "cables");
  docs.recent = await addCost("2026-10-05", "FAC-EL", "7777", 100000, "tornillos");
  docs.noNumber = await addCost("2024-01-15", null, null, 5000, `línea ${unique}`);

  const sale = await ok<{ id: string }>(
    db
      .from("sales_documents")
      .insert({
        company_id: ids.company,
        client_id: client.id,
        project_id: project.id,
        document_type: "invoice",
        document_number: "9191",
        document_date: "2020-06-01",
        currency: "CLP",
        net_amount: 1000,
        tax_amount: 190,
        total_amount: 1190,
      })
      .select("id")
      .single(),
  );
  docs.sale = sale.id;
}, 120_000);

afterAll(async () => {
  const failures: unknown[] = [];
  const step = async (p: PromiseLike<{ error: unknown }>) => {
    const { error } = await p;
    if (error) failures.push(error);
  };
  for (const company of [ids.company, ids.other].filter(Boolean)) {
    const costDocs = ((await db.from("cost_documents").select("id").eq("company_id", company)).data ?? []).map((r) => r.id);
    if (costDocs.length) await step(db.from("cost_lines").delete().in("cost_document_id", costDocs));
    await step(db.from("cost_documents").delete().eq("company_id", company));
    await step(db.from("sales_documents").delete().eq("company_id", company));
    await step(db.from("project_quotes").delete().eq("company_id", company));
    await step(db.from("projects").delete().eq("company_id", company));
    await step(db.from("clients").delete().eq("company_id", company));
    await step(db.from("suppliers").delete().eq("company_id", company));
    await step(db.from("company_memberships").delete().eq("company_id", company));
    await step(db.from("business_areas").delete().eq("company_id", company));
    await step(db.from("companies").delete().eq("id", company));
  }
  if (ids.user) {
    const { error } = await db.auth.admin.deleteUser(ids.user);
    if (error) failures.push(error);
  }
  if (failures.length) throw new Error(`cleanup failed (${tag}): ${JSON.stringify(failures)}`);
}, 120_000);

describe("search_cost_documents", () => {
  it("finds a folio of any year", async () => {
    expect((await searchCosts("156")).map((row) => row.id)).toEqual([docs.old]);
  });

  it("finds the type and folio written together, whatever the case", async () => {
    expect((await searchCosts("bol-he 156")).map((row) => row.id)).toEqual([docs.old]);
  });

  it("finds by supplier without accents, newest first, with the total", async () => {
    const rows = await searchCosts(`ferreteria ${unique}`);
    expect(rows.map((row) => row.id)).toEqual([docs.recent, docs.noNumber, docs.old]);
    expect(Number(rows[0].total_count)).toBe(3);
  });

  it("finds by RUT, with or without dots and hyphen", async () => {
    expect(await searchCosts("11.222.333-4")).toHaveLength(3);
    expect(await searchCosts("112223334")).toHaveLength(3);
  });

  it("finds by the description of a line", async () => {
    expect((await searchCosts(`línea ${unique}`)).map((row) => row.id)).toEqual([docs.noNumber]);
  });

  it("returns one page, keeping the total", async () => {
    const page = await searchCosts(`ferreteria ${unique}`, { p_limit: 1, p_offset: 1 });
    expect(page.map((row) => row.id)).toEqual([docs.noNumber]);
    expect(Number(page[0].total_count)).toBe(3);
  });

  it("sorts by total when asked", async () => {
    const rows = await searchCosts(`ferreteria ${unique}`, { p_sort: "total", p_ascending: true });
    expect(rows.map((row) => row.id)).toEqual([docs.noNumber, docs.recent, docs.old]);
  });

  it("finds nothing for an empty text, or a wildcard taken literally", async () => {
    expect(await searchCosts("   ")).toEqual([]);
    expect(await searchCosts("%")).toEqual([]);
  });

  it("finds nothing in a company the caller is not a member of", async () => {
    expect(await searchCosts("156", {}, ids.other)).toEqual([]);
    const seeded = await addCost("2026-01-01", "FAC-EL", `${unique}`, 10, "x");
    expect((await searchCosts(unique, {}, ids.other)).map((row) => row.id)).not.toContain(seeded);
  });
});

describe("search_sales_documents", () => {
  const searchSales = (query: string) =>
    ok<Row[]>(member.rpc("search_sales_documents", { p_company_id: ids.company, p_query: query }));

  it("finds by folio, client, RUT and job, in any year", async () => {
    for (const query of ["9191", `cliente ${unique}`, "55.666.777-8", `obra ${unique}`]) {
      expect((await searchSales(query)).map((row) => row.id), query).toEqual([docs.sale]);
    }
  });
});
