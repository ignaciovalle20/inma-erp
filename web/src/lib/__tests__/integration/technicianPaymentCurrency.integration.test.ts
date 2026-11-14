/**
 * Currency of a payment to a technician (20261114010000), against the real
 * inma-erp-dev project, as a signed-in member (RLS on), on throwaway
 * companies deleted at the end:
 *
 * 1. Uruguay: a technician with charges in USD and in UYU is paid in both;
 *    the cuenta corriente keeps one saldo per currency.
 * 2. A payment is refused by the database when it is applied to a charge of
 *    another currency (through the RPC and with a direct insert), or to
 *    charges of two currencies at once.
 * 3. A payment without p_currency takes the currency of its charges.
 * 4. A paid charge cannot change its currency; a payment cannot either.
 * 5. Chile: a payment is always CLP and can never be in USD.
 * 6. Every existing payment has its company's currency (the backfill).
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

import { getTechnicianAccount } from "@/lib/technicianDal";
import { accountCurrencies, defaultPaymentCurrency, summarizeByTechnician } from "@/lib/technicians";
import { executeTool } from "@/lib/ai/tools";

const tag = `TEST_PAY_CUR ${randomUUID().slice(0, 6)}`;
const db = serviceClient();
const ids = { uy: "", cl: "", user: "", uyProject: "", clProject: "", uyTech: "", clTech: "" };
const charges = { usd1: "", usd2: "", uyu: "", clp: "" };
let member: SupabaseClient;

async function ok<T = unknown>(p: PromiseLike<{ data: unknown; error: unknown }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(JSON.stringify(error));
  return data as T;
}

async function setUp(country: "UY" | "CL", currency: string) {
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
        currency,
      })
      .select("id")
      .single(),
  );
  const technician = await ok<{ id: string }>(
    member.from("personnel").insert({ company_id: company.id, name: `${tag} Técnico ${country}`, type: "contractor" }).select("id").single(),
  );
  return { company: company.id, project: project.id, technician: technician.id };
}

async function charge(project: string, technician: string, amount: number, date: string, currency?: string) {
  const row = await ok<{ id: string }>(
    member.rpc("create_technician_charge", {
      p_project_id: project,
      p_personnel_id: technician,
      p_description: `${tag} cargo`,
      p_charge_date: date,
      p_amount: amount,
      p_vat_included: false,
      p_vat_rate: 0,
      ...(currency ? { p_currency: currency } : {}),
    }),
  );
  return row.id;
}

const pay = (technician: string, amount: number, applications: { charge_id: string; amount: number }[], currency?: string) =>
  member.rpc("record_technician_payment", {
    p_personnel_id: technician,
    p_payment_date: "2026-11-10",
    p_amount: amount,
    p_method: "Transferencia",
    p_notes: tag,
    p_applications: applications,
    ...(currency ? { p_currency: currency } : {}),
  });

beforeAll(async () => {
  assertDevProject();
  const email = `test_pay_cur_${randomUUID().slice(0, 6)}@example.test`;
  const password = randomBytes(24).toString("base64url");
  const { data: user, error } = await db.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  ids.user = user.user.id;
  member = anonClient();
  const { error: signInError } = await member.auth.signInWithPassword({ email, password });
  if (signInError) throw signInError;
  memberClient = member;

  const uy = await setUp("UY", "UYU");
  ids.uy = uy.company;
  ids.uyProject = uy.project;
  ids.uyTech = uy.technician;
  const cl = await setUp("CL", "CLP");
  ids.cl = cl.company;
  ids.clProject = cl.project;
  ids.clTech = cl.technician;

  charges.usd1 = await charge(ids.uyProject, ids.uyTech, 300, "2026-10-05", "USD");
  charges.usd2 = await charge(ids.uyProject, ids.uyTech, 200, "2026-10-20", "USD");
  charges.uyu = await charge(ids.uyProject, ids.uyTech, 8000, "2026-10-10", "UYU");
  charges.clp = await charge(ids.clProject, ids.clTech, 100000, "2026-10-10");
}, 120_000);

afterAll(async () => {
  const failures: unknown[] = [];
  const step = async (p: PromiseLike<{ error: unknown }>) => {
    const { error } = await p;
    if (error) failures.push(error);
  };
  for (const company of [ids.uy, ids.cl].filter(Boolean)) {
    const costDocs = ((await db.from("cost_documents").select("id").eq("company_id", company)).data ?? []).map((r) => r.id);
    // Payments first: their applications go with them, and free the charges.
    await step(db.from("technician_payments").delete().eq("company_id", company));
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

describe("technician_payments.currency", () => {
  it("a new payment starts in the currency most pending charges are in", async () => {
    const { charges: rows } = await getTechnicianAccount(ids.uy, ids.uyTech);
    expect(defaultPaymentCurrency(rows.filter((row) => row.outstanding > 0), ["USD", "UYU"], "UYU")).toBe("USD");
  });

  it("refuses a payment applied to a charge of another currency (RPC and direct insert)", async () => {
    const wrong = await pay(ids.uyTech, 300, [{ charge_id: charges.usd1, amount: 300 }], "UYU");
    expect(wrong.error?.message).toMatch(/Un pago en UYU solo puede aplicarse a cargos en UYU: este cargo está en USD/);

    const reverse = await pay(ids.uyTech, 8000, [{ charge_id: charges.uyu, amount: 8000 }], "USD");
    expect(reverse.error?.message).toMatch(/Un pago en USD solo puede aplicarse a cargos en USD: este cargo está en UYU/);

    // Two currencies in one payment: whatever its currency, one charge is not in it.
    const mixed = [
      { charge_id: charges.usd1, amount: 300 },
      { charge_id: charges.uyu, amount: 8000 },
    ];
    expect((await pay(ids.uyTech, 8300, mixed, "USD")).error?.message).toMatch(/solo puede aplicarse a cargos en USD/);
    expect((await pay(ids.uyTech, 8300, mixed)).error?.message).toMatch(/cargos de una misma moneda: estos están en USD y UYU/);

    // Nothing was saved by the refused payments.
    const saved = await ok<unknown[]>(member.from("technician_payments").select("id").eq("company_id", ids.uy));
    expect(saved).toEqual([]);
  });

  it("pays in USD and in UYU, and the cuenta corriente keeps one saldo per currency", async () => {
    // USD 350: the first charge whole and 50 of the second. No p_currency: the charges'.
    const usd = await ok<{ id: string; currency: string }>(
      pay(ids.uyTech, 350, [
        { charge_id: charges.usd1, amount: 300 },
        { charge_id: charges.usd2, amount: 50 },
      ]),
    );
    expect(usd.currency).toBe("USD");
    const uyu = await ok<{ id: string; currency: string }>(pay(ids.uyTech, 3000, [{ charge_id: charges.uyu, amount: 3000 }], "UYU"));
    expect(uyu.currency).toBe("UYU");

    // A direct insert of an application cannot cross currencies either (the trigger, not the RPC).
    const crossed = await db
      .from("technician_payment_applications")
      .insert({ company_id: ids.uy, payment_id: uyu.id, charge_id: charges.usd2, amount: 10 });
    expect(crossed.error?.message).toMatch(/solo puede aplicarse a cargos en UYU/);

    const account = await getTechnicianAccount(ids.uy, ids.uyTech);
    expect(accountCurrencies(account.charges, account.payments, "UYU")).toEqual(["UYU", "USD"]);
    expect(summarizeByTechnician(account.charges).get(ids.uyTech)?.byCurrency).toEqual([
      { currency: "USD", chargeCount: 2, charged: 500, paid: 350, balance: 150 },
      { currency: "UYU", chargeCount: 1, charged: 8000, paid: 3000, balance: 5000 },
    ]);
    expect(
      account.payments.map((payment) => [payment.currency, Number(payment.amount)]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    ).toEqual([
      ["USD", 350],
      ["UYU", 3000],
    ]);

    // The assistant's saldos: one per currency.
    const outcome = await executeTool("get_technician_balances", {}, { companyId: ids.uy });
    const row = (outcome.result as { technician: string; outstanding_by_currency: { currency: string; outstanding: number }[] }[]).find(
      (candidate) => candidate.technician === `${tag} Técnico UY`,
    );
    expect([...(row?.outstanding_by_currency ?? [])].sort((a, b) => a.currency.localeCompare(b.currency))).toEqual([
      { currency: "USD", outstanding: 150 },
      { currency: "UYU", outstanding: 5000 },
    ]);
  });

  it("a paid charge cannot change its currency, and a payment cannot either", async () => {
    const edit = await member.rpc("update_uruguay_technician_charge", {
      p_charge_id: charges.uyu,
      p_description: "x",
      p_charge_date: "2026-10-10",
      p_amount: 8000,
      p_vat_included: false,
      p_unbacked: true,
      p_currency: "USD",
    });
    expect(edit.error?.message).toMatch(/already has payments applied/);

    // Even with the service role, past the RPC.
    const direct = await db.from("technician_charges").update({ currency: "USD" }).eq("id", charges.uyu);
    expect(direct.error).not.toBeNull();

    const payment = await ok<{ id: string }>(
      db.from("technician_payments").select("id").eq("company_id", ids.uy).eq("currency", "UYU").single(),
    );
    const moved = await db.from("technician_payments").update({ currency: "USD" }).eq("id", payment.id);
    expect(moved.error?.message).toMatch(/no puede cambiar de moneda/);
  });

  it("Chile: a payment is CLP, with or without p_currency, and never USD", async () => {
    const usd = await pay(ids.clTech, 1000, [{ charge_id: charges.clp, amount: 1000 }], "USD");
    expect(usd.error?.message).toMatch(/La moneda USD no es una de las de la empresa/);

    const plain = await ok<{ currency: string }>(pay(ids.clTech, 40000, [{ charge_id: charges.clp, amount: 40000 }]));
    expect(plain.currency).toBe("CLP");
    const given = await ok<{ currency: string }>(pay(ids.clTech, 10000, [{ charge_id: charges.clp, amount: 10000 }], "CLP"));
    expect(given.currency).toBe("CLP");

    const account = await getTechnicianAccount(ids.cl, ids.clTech);
    expect(accountCurrencies(account.charges, account.payments, "CLP")).toEqual(["CLP"]);
    expect(summarizeByTechnician(account.charges).get(ids.clTech)?.byCurrency).toEqual([
      { currency: "CLP", chargeCount: 1, charged: 100000, paid: 50000, balance: 50000 },
    ]);
  });

  it("every payment covers charges of its own currency only (the backfill left none crossed)", async () => {
    const rows = await ok<{ technician_payments: { currency: string }; technician_charges: { currency: string } }[]>(
      db.from("technician_payment_applications").select("technician_payments (currency), technician_charges (currency)"),
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((row) => row.technician_payments.currency !== row.technician_charges.currency)).toEqual([]);
  });
});
