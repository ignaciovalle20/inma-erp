/**
 * allocate_recurring_service_cost_pool (MS licenses split) against the real
 * inma-erp-dev project: the parts add up to the invoice exactly, no part is
 * ever negative, a voided cycle takes nothing and a cycle sold at 0 takes
 * nothing. Expected shares are worked out by hand. Run with
 * `npm run test:integration`.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { anonClient, assertDevProject, serviceClient } from "./devProject";

const tag = `TEST_ACCT_POOL ${randomUUID().slice(0, 6)}`;
const db = serviceClient();
const ids = { company: "", user: "", client: "", services: [] as string[] };
let member: SupabaseClient;

async function ok(p: PromiseLike<{ data: unknown; error: unknown }>): Promise<unknown> {
  const { data, error } = await p;
  if (error) throw new Error(JSON.stringify(error));
  return data;
}

/** Creates one MS cycle per amount in `period` and splits `total` over them. */
async function split(period: string, cycles: { amount: number; status?: string }[], total: number) {
  const occurrenceIds: string[] = [];
  for (const [i, cycle] of cycles.entries()) {
    const service = await ok(
      member
        .from("recurring_services")
        .insert({
          company_id: ids.company, client_id: ids.client, name: `${tag} ${period} ${i}`, price: cycle.amount,
          expected_cost: 0, currency: "CLP", periodicity: "monthly", start_date: "1997-01-01", end_date: "1997-12-31",
          status: "active", active: true, service_type: "ms_licenses", uses_cost_pool: true,
        })
        .select("id")
        .single(),
    );
    ids.services.push((service as { id: string }).id);
    const occurrence = await ok(
      member
        .from("recurring_service_occurrences")
        .insert({ recurring_service_id: (service as { id: string }).id, period, amount: cycle.amount, currency: "CLP", status: cycle.status ?? "invoiced" })
        .select("id")
        .single(),
    );
    occurrenceIds.push((occurrence as { id: string }).id);
  }
  const pool = await ok(
    member
      .from("recurring_service_cost_pools")
      .insert({ company_id: ids.company, service_type: "ms_licenses", period, total_expense_amount: total, currency: "CLP" })
      .select("id")
      .single(),
  );
  const { data, error } = await member.rpc("allocate_recurring_service_cost_pool", { p_cost_pool_id: (pool as { id: string }).id });
  if (error) throw new Error(error.message);
  const rows = data as { occurrence_id: string; allocated_amount: number }[];
  return occurrenceIds.map((id) => {
    const row = rows.find((r) => r.occurrence_id === id);
    return row ? Number(row.allocated_amount) : null;
  });
}

beforeAll(async () => {
  assertDevProject();
  const company = await ok(db.from("companies").insert({ name: tag, country: "CL", currency: "CLP" }).select("id").single());
  ids.company = (company as { id: string }).id;
  const email = `test_acct_pool_${randomUUID().slice(0, 6)}@example.test`;
  const password = randomBytes(24).toString("base64url");
  const { data: user, error } = await db.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  ids.user = user.user.id;
  await ok(db.from("company_memberships").insert({ user_id: ids.user, company_id: ids.company, role: "admin" }).select("id"));
  member = anonClient();
  const { error: signInError } = await member.auth.signInWithPassword({ email, password });
  if (signInError) throw signInError;
  const client = await ok(member.from("clients").insert({ company_id: ids.company, name: tag }).select("id").single());
  ids.client = (client as { id: string }).id;
}, 120_000);

afterAll(async () => {
  const failures: unknown[] = [];
  const step = async (p: PromiseLike<{ error: unknown }>) => {
    const { error } = await p;
    if (error) failures.push(error);
  };
  if (ids.company) {
    const pools = ((await db.from("recurring_service_cost_pools").select("id").eq("company_id", ids.company)).data ?? []).map((r) => r.id);
    if (pools.length) await step(db.from("recurring_service_cost_allocations").delete().in("cost_pool_id", pools));
    await step(db.from("recurring_service_cost_pools").delete().eq("company_id", ids.company));
    if (ids.services.length) await step(db.from("recurring_service_occurrences").delete().in("recurring_service_id", ids.services));
    await step(db.from("recurring_services").delete().eq("company_id", ids.company));
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

describe("allocate_recurring_service_cost_pool", () => {
  it("shares that would all round up never leave a negative part (1+1+1+1 over 2 CLP -> 1,1,0,0)", async () => {
    const shares = await split("1997-01-01", [{ amount: 1 }, { amount: 1 }, { amount: 1 }, { amount: 1 }], 2);
    expect([...shares].sort()).toEqual([0, 0, 1, 1]);
  });

  it("a voided cycle takes nothing and a cycle sold at 0 takes nothing", async () => {
    const shares = await split(
      "1997-02-01",
      [{ amount: 1_000 }, { amount: 1_000 }, { amount: 1_000 }, { amount: 0 }, { amount: 3_000, status: "void" }],
      1_000,
    );
    expect(shares[4]).toBeNull();
    expect(shares[3]).toBe(0);
    expect(shares.slice(0, 3).map(Number).sort()).toEqual([333, 333, 334]);
  });

  it("the larger remainder gets the extra unit, and the parts add up to the invoice", async () => {
    // 100/200/700 of 1.001: exact 100,1 / 200,2 / 700,7 -> floor 100/200/700,
    // one unit left -> the .7 one: 100 / 200 / 701.
    const shares = await split("1997-03-01", [{ amount: 100 }, { amount: 200 }, { amount: 700 }], 1_001);
    expect(shares).toEqual([100, 200, 701]);
  });

  it("one client takes the whole invoice", async () => {
    expect(await split("1997-04-01", [{ amount: 500 }], 999)).toEqual([999]);
  });
});
