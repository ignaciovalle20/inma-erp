/**
 * One normalization of a RUT and a technician's suppliers linked from both
 * sides (20261031020000), against the real inma-erp-dev project, as a signed-in
 * member (RLS on). Supplier first or technician first, the link is the same;
 * the database's normalize_tax_id says what lib/rut.ts says. RUTs are invented.
 *
 * Run with `npm run test:integration`.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { anonClient, assertDevProject, serviceClient } from "./devProject";
import { normalizeRut } from "@/lib/rut";

const tag = `TEST_RUT ${randomUUID().slice(0, 6)}`;
const db = serviceClient();
const ids = { cl: "", uy: "", user: "" };
let member: SupabaseClient;

async function ok<T = unknown>(p: PromiseLike<{ data: unknown; error: unknown }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(JSON.stringify(error));
  return data as T;
}

const addSupplier = (company: string, name: string, taxId: string | null) =>
  ok<{ id: string; tax_id: string | null }>(
    member.from("suppliers").insert({ company_id: company, name: `${tag} ${name}`, tax_id: taxId }).select("id, tax_id").single(),
  );

const addTechnician = (company: string, name: string, taxId: string | null) =>
  ok<{ id: string; tax_id: string | null }>(
    member.from("personnel").insert({ company_id: company, name: `${tag} ${name}`, type: "contractor", tax_id: taxId }).select("id, tax_id").single(),
  );

const ownerOf = async (supplierId: string) => {
  const rows = await ok<{ personnel_id: string }[]>(
    member.from("technician_suppliers").select("personnel_id").eq("supplier_id", supplierId),
  );
  return rows[0]?.personnel_id ?? null;
};

beforeAll(async () => {
  assertDevProject();
  const email = `test_rut_${randomUUID().slice(0, 6)}@example.test`;
  const password = randomBytes(24).toString("base64url");
  const { data: user, error } = await db.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  ids.user = user.user.id;
  for (const [key, country, currency] of [["cl", "CL", "CLP"], ["uy", "UY", "UYU"]] as const) {
    const company = await ok<{ id: string }>(
      db.from("companies").insert({ name: `${tag} ${country}`, country, currency }).select("id").single(),
    );
    ids[key] = company.id;
    await ok(db.from("company_memberships").insert({ user_id: ids.user, company_id: company.id, role: "admin" }).select("id"));
  }
  member = anonClient();
  const { error: signInError } = await member.auth.signInWithPassword({ email, password });
  if (signInError) throw signInError;
}, 120_000);

afterAll(async () => {
  const failures: unknown[] = [];
  const step = async (p: PromiseLike<{ error: unknown }>) => {
    const { error } = await p;
    if (error) failures.push(error);
  };
  for (const company of [ids.cl, ids.uy].filter(Boolean)) {
    await step(db.from("technician_suppliers").delete().eq("company_id", company));
    await step(db.from("personnel").delete().eq("company_id", company));
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

describe("normalize_tax_id", () => {
  it.each(["13.765.872-0", "137658720", " 013765872-0 ", "12.345.678-k", "12345678K", "9922443-6"])(
    "says what lib/rut.ts says for %s",
    async (input) => {
      expect(await ok<string>(member.rpc("normalize_tax_id", { p_tax_id: input }))).toBe(normalizeRut(input));
    },
  );

  it("compares anything else by its alphanumeric characters, and nothing is null", async () => {
    expect(await ok<string>(member.rpc("normalize_tax_id", { p_tax_id: "ab-12" }))).toBe("AB12");
    expect(await ok<string | null>(member.rpc("normalize_tax_id", { p_tax_id: " - " }))).toBeNull();
  });
});

describe("a technician's RUT and their suppliers (Chile)", () => {
  it("links when the RUT is typed in the ficha after the supplier exists, in any format", async () => {
    const supplier = await addSupplier(ids.cl, "boleta", "11.222.333-4");
    expect(supplier.tax_id).toBe("11222333-4");
    expect(await ownerOf(supplier.id)).toBeNull();

    const technician = await addTechnician(ids.cl, "técnico A", null);
    const edited = await ok<{ tax_id: string }>(
      member.from("personnel").update({ tax_id: "112223334" }).eq("id", technician.id).select("tax_id").single(),
    );
    expect(edited.tax_id).toBe("11222333-4");
    expect(await ownerOf(supplier.id)).toBe(technician.id);
  });

  it("links a supplier created after the technician, with leading zeros and a lower-case K", async () => {
    const technician = await addTechnician(ids.cl, "técnico B", "12.111.222-K");
    expect(technician.tax_id).toBe("12111222-K");
    const supplier = await addSupplier(ids.cl, "boleta B", "012111222k");
    expect(supplier.tax_id).toBe("12111222-K");
    expect(await ownerOf(supplier.id)).toBe(technician.id);
  });

  it("links a supplier that gets its RUT later", async () => {
    const technician = await addTechnician(ids.cl, "técnico C", "13.111.222-3");
    const supplier = await addSupplier(ids.cl, "sin rut", null);
    expect(await ownerOf(supplier.id)).toBeNull();
    await ok(member.from("suppliers").update({ tax_id: "131112223" }).eq("id", supplier.id).select("id"));
    expect(await ownerOf(supplier.id)).toBe(technician.id);
  });

  it("recognizes the company's RUT of a technician, linked by hand, on a new supplier", async () => {
    const technician = await addTechnician(ids.cl, "técnico D", "14.111.222-3");
    const company = await addSupplier(ids.cl, "EIRL", "76.111.222-3");
    await ok(
      member.from("technician_suppliers").insert({ company_id: ids.cl, personnel_id: technician.id, supplier_id: company.id }).select("id"),
    );
    const sameCompany = await addSupplier(ids.cl, "EIRL otra razón", "761112223");
    expect(await ownerOf(sameCompany.id)).toBe(technician.id);
  });

  it("does not guess between two technicians with the same RUT", async () => {
    const supplier = await addSupplier(ids.cl, "de dos", "15.111.222-3");
    await addTechnician(ids.cl, "técnico E", "15111222-3");
    expect(await ownerOf(supplier.id)).not.toBeNull();

    const other = await addSupplier(ids.cl, "de dos otra", "16.111.222-3");
    const first = await addTechnician(ids.cl, "técnico F", null);
    const second = await addTechnician(ids.cl, "técnico G", "16.111.222-3");
    expect(await ownerOf(other.id)).toBe(second.id);
    await ok(member.from("personnel").update({ tax_id: "16.111.222-3" }).eq("id", first.id).select("id"));
    // The first link stays; the second technician's RUT does not move it.
    expect(await ownerOf(other.id)).toBe(second.id);
    const unowned = await addSupplier(ids.cl, "de dos nueva", "161112223");
    expect(await ownerOf(unowned.id)).toBeNull();
  });
});

describe("a company that is not Chilean", () => {
  it("keeps the tax id as typed and links nothing", async () => {
    const supplier = await addSupplier(ids.uy, "RUC", " 21.784.532-0018 ");
    expect(supplier.tax_id).toBe("21.784.532-0018");
    const technician = await addTechnician(ids.uy, "técnico UY", "1.234.567-8");
    expect(technician.tax_id).toBe("1.234.567-8");
    const sameRut = await addSupplier(ids.uy, "CI", "1.234.567-8");
    expect(await ownerOf(sameRut.id)).toBeNull();
  });
});
