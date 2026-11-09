/**
 * Currency of a technician charge (20261109020000), against the real
 * inma-erp-dev project, as a signed-in member (RLS on):
 *
 * 1. Uruguay: a charge in USD (sin respaldo and con IVA) is saved in USD and
 *    so is its own cost document; correcting it to UYU moves both.
 * 2. Without p_currency a charge is in the company's currency.
 * 3. Chile: a charge cannot be in USD.
 *
 * Run with `npm run test:integration`.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { anonClient, assertDevProject, serviceClient } from "./devProject";

const tag = `TEST_CHARGE_CUR ${randomUUID().slice(0, 6)}`;
const db = serviceClient();
const ids = { uy: "", cl: "", user: "", uyProject: "", clProject: "", uyTech: "", clTech: "" };
let member: SupabaseClient;

async function ok<T = unknown>(p: PromiseLike<{ data: unknown; error: unknown }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(JSON.stringify(error));
  return data as T;
}

type ChargeRow = { id: string; currency: string; amount: number; net_amount: number; cost_document_id: string };

const readCharge = (id: string) =>
  ok<ChargeRow & { cost_documents: { currency: string; net_amount: number } }>(
    member
      .from("technician_charges")
      .select("id, currency, amount, net_amount, cost_document_id, cost_documents (currency, net_amount)")
      .eq("id", id)
      .single(),
  );

async function setUp(country: "UY" | "CL", currency: string, projectCurrency: string) {
  const company = await ok<{ id: string }>(
    db.from("companies").insert({ name: `${tag} ${country}`, country, currency }).select("id").single(),
  );
  await ok(db.from("company_memberships").insert({ user_id: ids.user, company_id: company.id, role: "admin" }).select("id"));
  const client = await ok<{ id: string }>(
    member.from("clients").insert({ company_id: company.id, name: `${tag} ${country}` }).select("id").single(),
  );
  const area = await ok<{ id: string }>(db.from("business_areas").select("id").eq("company_id", company.id).limit(1).single());
  const project = await ok<{ id: string }>(
    member
      .from("projects")
      .insert({
        company_id: company.id,
        client_id: client.id,
        business_area_id: area.id,
        name: `${tag} ${country} trabajo`,
        status: "en_ejecucion",
        currency: projectCurrency,
      })
      .select("id")
      .single(),
  );
  const technician = await ok<{ id: string }>(
    member.from("personnel").insert({ company_id: company.id, name: `${tag} Técnico`, type: "contractor" }).select("id").single(),
  );
  return { company: company.id, project: project.id, technician: technician.id };
}

beforeAll(async () => {
  assertDevProject();
  const email = `test_charge_cur_${randomUUID().slice(0, 6)}@example.test`;
  const password = randomBytes(24).toString("base64url");
  const { data: user, error } = await db.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  ids.user = user.user.id;
  member = anonClient();
  const { error: signInError } = await member.auth.signInWithPassword({ email, password });
  if (signInError) throw signInError;

  const uy = await setUp("UY", "UYU", "USD");
  ids.uy = uy.company;
  ids.uyProject = uy.project;
  ids.uyTech = uy.technician;
  const cl = await setUp("CL", "CLP", "CLP");
  ids.cl = cl.company;
  ids.clProject = cl.project;
  ids.clTech = cl.technician;
}, 120_000);

afterAll(async () => {
  const failures: unknown[] = [];
  const step = async (p: PromiseLike<{ error: unknown }>) => {
    const { error } = await p;
    if (error) failures.push(error);
  };
  for (const company of [ids.uy, ids.cl].filter(Boolean)) {
    const costDocs = ((await db.from("cost_documents").select("id").eq("company_id", company)).data ?? []).map((r) => r.id);
    await step(db.from("technician_charges").delete().eq("company_id", company));
    if (costDocs.length) await step(db.from("cost_lines").delete().in("cost_document_id", costDocs));
    await step(db.from("cost_documents").delete().eq("company_id", company));
    await step(db.from("personnel").delete().eq("company_id", company));
    await step(db.from("projects").delete().eq("company_id", company));
    await step(db.from("clients").delete().eq("company_id", company));
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

describe("technician_charges.currency", () => {
  it("Uruguay: a USD charge and its cost document are in USD; correcting it to UYU moves both", async () => {
    const created = await ok<ChargeRow>(
      member.rpc("create_unbacked_technician_charge", {
        p_project_id: ids.uyProject,
        p_personnel_id: ids.uyTech,
        p_description: "visita",
        p_charge_date: "2026-10-15",
        p_amount: 150,
        p_currency: "USD",
      }),
    );
    let charge = await readCharge(created.id);
    expect(charge.currency).toBe("USD");
    expect(charge.cost_documents.currency).toBe("USD");
    expect(Number(charge.net_amount)).toBe(150);

    await ok(
      member.rpc("update_uruguay_technician_charge", {
        p_charge_id: created.id,
        p_description: "visita",
        p_charge_date: "2026-10-15",
        p_amount: 6000,
        p_vat_included: false,
        p_unbacked: true,
        p_currency: "UYU",
      }),
    );
    charge = await readCharge(created.id);
    expect(charge.currency).toBe("UYU");
    expect(charge.cost_documents.currency).toBe("UYU");
    expect(Number(charge.cost_documents.net_amount)).toBe(6000);

    // Without p_currency an edit keeps the charge's currency.
    await ok(
      member.rpc("update_uruguay_technician_charge", {
        p_charge_id: created.id,
        p_description: "visita",
        p_charge_date: "2026-10-15",
        p_amount: 6100,
        p_vat_included: false,
        p_unbacked: true,
      }),
    );
    expect((await readCharge(created.id)).currency).toBe("UYU");
  });

  it("Uruguay: con IVA in USD keeps the net in USD; without p_currency it is the company's", async () => {
    const usd = await ok<ChargeRow>(
      member.rpc("create_technician_charge", {
        p_project_id: ids.uyProject,
        p_personnel_id: ids.uyTech,
        p_description: null,
        p_charge_date: "2026-10-15",
        p_amount: 122,
        p_vat_included: true,
        p_vat_rate: 0.22,
        p_currency: "USD",
      }),
    );
    expect(usd.currency).toBe("USD");
    expect(Number(usd.net_amount)).toBe(100);

    const plain = await ok<ChargeRow>(
      member.rpc("create_technician_charge", {
        p_project_id: ids.uyProject,
        p_personnel_id: ids.uyTech,
        p_description: null,
        p_charge_date: "2026-10-15",
        p_amount: 1000,
        p_vat_included: false,
        p_vat_rate: 0.22,
      }),
    );
    expect((await readCharge(plain.id)).currency).toBe("UYU");
    expect((await readCharge(plain.id)).cost_documents.currency).toBe("UYU");
  });

  it("Chile: a charge is CLP and can never be in USD", async () => {
    const { error } = await member.rpc("create_technician_charge", {
      p_project_id: ids.clProject,
      p_personnel_id: ids.clTech,
      p_description: null,
      p_charge_date: "2026-10-15",
      p_amount: 1000,
      p_vat_included: false,
      p_vat_rate: 0.19,
      p_currency: "USD",
    });
    expect(error?.message).toMatch(/moneda USD/);

    const backed = await ok<ChargeRow>(
      member.rpc("create_backed_technician_charge", {
        p_project_id: ids.clProject,
        p_personnel_id: ids.clTech,
        p_description: null,
        p_charge_date: "2026-10-15",
        p_backing: "none",
        p_entered_as: "amount",
        p_value: 50000,
      }),
    );
    expect((await readCharge(backed.id)).currency).toBe("CLP");
  });

  it("the currency cannot be changed outside the edit RPCs", async () => {
    const charge = await ok<ChargeRow>(
      member.rpc("create_unbacked_technician_charge", {
        p_project_id: ids.uyProject,
        p_personnel_id: ids.uyTech,
        p_description: null,
        p_charge_date: "2026-10-15",
        p_amount: 10,
        p_currency: "USD",
      }),
    );
    const { error } = await db.from("technician_charges").update({ currency: "UYU" }).eq("id", charge.id);
    expect(error).not.toBeNull();
  });
});
