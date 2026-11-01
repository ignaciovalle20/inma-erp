/**
 * apply_technician_document (20261101020000) against the real inma-erp-dev
 * project, as a signed-in member (RLS on): a document over several charges of
 * several jobs, partial applications, a difference confirmed explicitly, a
 * charge without backing taking the document's. Amounts are the FAC-EL 257's.
 *
 * Run with `npm run test:integration`.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { anonClient, assertDevProject, serviceClient } from "./devProject";

const tag = `TEST_APPLY ${randomUUID().slice(0, 6)}`;
const db = serviceClient();
const ids = { company: "", user: "", client: "", area: "", tech: "", otherTech: "", personal: "", business: "", other: "", batch: "" };
const jobs: string[] = [];
const documents: string[] = [];
let member: SupabaseClient;
let nextRow = 1;
let nextFolio = 1000;

async function ok<T = unknown>(p: PromiseLike<{ data: unknown; error: unknown }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(JSON.stringify(error));
  return data as T;
}

async function fails(p: PromiseLike<{ error: { message: string } | null }>): Promise<string> {
  const { error } = await p;
  expect(error).not.toBeNull();
  return error!.message;
}

type Item = { charge_id: string; amount: number; entered_as?: string };
const apply = (document: string, items: Item[], accept = false, replace = false) =>
  member.rpc("apply_technician_document", {
    p_cost_document_id: document,
    p_items: items,
    p_replace_allocations: replace,
    p_accept_difference: accept,
  });
const unlink = (document: string) => member.rpc("unlink_technician_document", { p_cost_document_id: document });

async function charge(backing: string, enteredAs: string, value: number, job = 0, tech = ids.tech): Promise<string> {
  const row = await ok<{ id: string }>(
    member.rpc("create_backed_technician_charge", {
      p_project_id: jobs[job],
      p_personnel_id: tech,
      p_description: null,
      p_charge_date: "2026-06-15",
      p_backing: backing,
      p_entered_as: enteredAs,
      p_value: value,
    }),
  );
  return row.id;
}

async function invoice(net: number, type = "FAC-EL", supplier = ids.business): Promise<string> {
  const folio = String(nextFolio++);
  const tax = type === "FAC-EL" ? Math.round(net * 0.19) : 0;
  const [row] = await ok<{ cost_document_id: string; status: string }[]>(
    member.rpc("import_cost_rows_batch", {
      p_import_batch_id: ids.batch,
      p_rows: [
        {
          row_number: nextRow++,
          raw_data: { "Tipo documento": type, "Nº documento": folio },
          supplier_id: supplier,
          document_date: "2026-06-30",
          currency: "CLP",
          amount: net,
          exempt_amount: 0,
          tax_amount: tax,
          other_taxes: 0,
          document_type: "invoice",
          source_document_type: type,
          document_number: folio,
          force: false,
          link_to_cost_document_id: null,
        },
      ],
    }),
  );
  expect(row.status).toBe("imported");
  documents.push(row.cost_document_id);
  return row.cost_document_id;
}

const chargeRow = (id: string) =>
  ok<{ document_status: string; backing: string; entered_as: string; amount: number; net_amount: number; cost_document_id: string }>(
    db.from("technician_charges").select("document_status, backing, entered_as, amount, net_amount, cost_document_id").eq("id", id).single(),
  );
const documentRow = (id: string) =>
  ok<{ classification: string; net_amount: number; total_amount: number; technician_linked_amount: number }>(
    db.from("cost_documents").select("classification, net_amount, total_amount, technician_linked_amount").eq("id", id).single(),
  );

beforeAll(async () => {
  assertDevProject();
  const email = `test_apply_${randomUUID().slice(0, 6)}@example.test`;
  const password = randomBytes(24).toString("base64url");
  const { data: user, error } = await db.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  ids.user = user.user.id;
  const company = await ok<{ id: string }>(db.from("companies").insert({ name: `${tag} CL`, country: "CL", currency: "CLP" }).select("id").single());
  ids.company = company.id;
  await ok(db.from("company_memberships").insert({ user_id: ids.user, company_id: ids.company, role: "admin" }).select("id"));
  member = anonClient();
  const { error: signInError } = await member.auth.signInWithPassword({ email, password });
  if (signInError) throw signInError;

  const client = await ok<{ id: string }>(db.from("clients").insert({ company_id: ids.company, name: `${tag} cliente` }).select("id").single());
  const area = await ok<{ id: string }>(db.from("business_areas").insert({ company_id: ids.company, name: `${tag} area` }).select("id").single());
  ids.client = client.id;
  ids.area = area.id;
  for (const name of ["Redes", "Starlink", "Tintas", "HIK"]) {
    const job = await ok<{ id: string }>(
      db.from("projects").insert({ company_id: ids.company, client_id: client.id, business_area_id: area.id, name: `${tag} ${name}`, status: "en_ejecucion" }).select("id").single(),
    );
    jobs.push(job.id);
  }
  const tech = await ok<{ id: string }>(
    member.from("personnel").insert({ company_id: ids.company, name: `${tag} Luis`, type: "contractor", tax_id: "13.765.872-0" }).select("id").single(),
  );
  ids.tech = tech.id;
  const other = await ok<{ id: string }>(
    member.from("personnel").insert({ company_id: ids.company, name: `${tag} Otro`, type: "contractor" }).select("id").single(),
  );
  ids.otherTech = other.id;
  // Personal RUT: linked by the database. Company RUT: linked by hand in the ficha.
  const personal = await ok<{ id: string }>(
    member.from("suppliers").insert({ company_id: ids.company, name: `${tag} Luis`, tax_id: "13765872-0" }).select("id").single(),
  );
  ids.personal = personal.id;
  const business = await ok<{ id: string }>(
    member.from("suppliers").insert({ company_id: ids.company, name: `${tag} Luis E.I.R.L.`, tax_id: "76577457-8" }).select("id").single(),
  );
  ids.business = business.id;
  await ok(member.from("technician_suppliers").insert({ company_id: ids.company, personnel_id: ids.tech, supplier_id: business.id }).select("id"));
  const notTech = await ok<{ id: string }>(
    member.from("suppliers").insert({ company_id: ids.company, name: `${tag} Proveedor`, tax_id: "76000000-0" }).select("id").single(),
  );
  ids.other = notTech.id;
  const batch = await ok<{ id: string }>(
    member.rpc("create_cost_import_batch", { p_company_id: ids.company, p_file_name: `${tag}.csv`, p_total_rows: 1 }),
  );
  ids.batch = batch.id;
}, 120_000);

afterAll(async () => {
  const failures: unknown[] = [];
  const step = async (p: PromiseLike<{ error: unknown }>) => {
    const { error } = await p;
    if (error) failures.push(error);
  };
  for (const document of documents) await unlink(document);
  await step(db.from("technician_document_suggestions").delete().eq("company_id", ids.company));
  await step(db.from("technician_payments").delete().eq("company_id", ids.company));
  await step(db.from("technician_charges").delete().eq("company_id", ids.company));
  await step(db.from("technician_suppliers").delete().eq("company_id", ids.company));
  await step(db.from("personnel").delete().eq("company_id", ids.company));
  const docs = (await db.from("cost_documents").select("id").eq("company_id", ids.company)).data ?? [];
  const docIds = docs.map((row) => row.id);
  if (docIds.length > 0) {
    await step(db.from("cost_allocations").delete().in("cost_document_id", docIds));
    await step(db.from("cost_lines").delete().in("cost_document_id", docIds));
  }
  await step(db.from("cost_documents").update({ import_row_id: null }).eq("company_id", ids.company));
  await step(db.from("cost_import_rows").delete().eq("import_batch_id", ids.batch));
  await step(db.from("cost_documents").delete().eq("company_id", ids.company));
  await step(db.from("cost_import_batches").delete().eq("company_id", ids.company));
  await step(db.from("projects").delete().eq("company_id", ids.company));
  await step(db.from("suppliers").delete().eq("company_id", ids.company));
  await step(db.from("clients").delete().eq("company_id", ids.company));
  await step(db.from("business_areas").delete().eq("company_id", ids.company));
  await step(db.from("company_memberships").delete().eq("company_id", ids.company));
  await step(db.from("companies").delete().eq("id", ids.company));
  if (ids.user) {
    const { error } = await db.auth.admin.deleteUser(ids.user);
    if (error) failures.push(error);
  }
  if (failures.length) throw new Error(`cleanup failed (${tag}): ${JSON.stringify(failures)}`);
}, 120_000);

describe("apply_technician_document", () => {
  it("covers charges of 4 jobs from the company's RUT, net with net", async () => {
    const charges = [
      await charge("factura", "total", 2_000_000, 0),
      await charge("factura", "total", 400_000, 1),
      await charge("factura", "total", 45_000, 2),
      await charge("factura", "total", 109_993, 3),
    ];
    const document = await invoice(2_147_053);
    const items = [
      { charge_id: charges[0], amount: 1_680_672 },
      { charge_id: charges[1], amount: 336_134 },
      { charge_id: charges[2], amount: 37_815 },
      { charge_id: charges[3], amount: 92_431 },
    ];
    const result = await ok<{ charges: number; projects: number; difference: number }>(apply(document, items));
    expect(result).toMatchObject({ charges: 4, projects: 4, difference: 1 });
    expect(await documentRow(document)).toMatchObject({ classification: "general", technician_linked_amount: 2_147_052 });
    for (const id of charges) expect((await chargeRow(id)).document_status).toBe("recibida");
    // The charges keep their own direct cost: the document only backs them.
    const own = await ok<{ net_amount: number }>(
      db.from("cost_documents").select("net_amount").eq("id", (await chargeRow(charges[0])).cost_document_id).single(),
    );
    expect(own.net_amount).toBe(1_680_672);
  });

  it("a difference is refused until it is confirmed; what is left stays a general cost", async () => {
    const id = await charge("factura", "net", 100_000);
    const document = await invoice(150_000);
    expect(await fails(apply(document, [{ charge_id: id, amount: 100_000 }]))).toMatch(/^AMOUNT_MISMATCH: /);
    expect((await chargeRow(id)).document_status).toBe("pendiente");
    await ok(apply(document, [{ charge_id: id, amount: 100_000 }], true));
    expect((await documentRow(document)).technician_linked_amount).toBe(100_000);
  });

  it("a charge can be covered in parts by two documents, never over its cost", async () => {
    const id = await charge("factura", "net", 100_000);
    const first = await invoice(60_000);
    const second = await invoice(40_000);
    await ok(apply(first, [{ charge_id: id, amount: 60_000 }]));
    expect((await chargeRow(id)).document_status).toBe("pendiente");
    expect(await fails(apply(second, [{ charge_id: id, amount: 40_001 }], true))).toMatch(/quedan 40000 por cubrir/);
    await ok(apply(second, [{ charge_id: id, amount: 40_000 }]));
    expect((await chargeRow(id)).document_status).toBe("recibida");

    // Unlinking one of them leaves it pending of what that one covered.
    await ok(unlink(second));
    expect((await chargeRow(id)).document_status).toBe("pendiente");
    expect((await documentRow(first)).technician_linked_amount).toBe(60_000);
  });

  it("a charge without backing takes the document's: read as the total, what it pays stays, even paid", async () => {
    const id = await charge("none", "amount", 400_000, 1);
    await ok(
      member.rpc("record_technician_payment", {
        p_personnel_id: ids.tech,
        p_payment_date: "2026-06-20",
        p_amount: 400_000,
        p_method: null,
        p_notes: null,
        p_applications: [{ charge_id: id, amount: 400_000 }],
      }),
    );
    const document = await invoice(336_134);
    await ok(apply(document, [{ charge_id: id, amount: 336_134, entered_as: "total" }]));
    const after = await chargeRow(id);
    expect(after).toMatchObject({ backing: "factura", entered_as: "total", amount: 400_000, net_amount: 336_134, document_status: "recibida" });
    const own = await ok<{ net_amount: number; tax_amount: number; total_amount: number }>(
      db.from("cost_documents").select("net_amount, tax_amount, total_amount").eq("id", after.cost_document_id).single(),
    );
    expect(own).toEqual({ net_amount: 336_134, tax_amount: 63_866, total_amount: 400_000 });
  });

  it("read as the net, it pays the IVA on top; a boleta cannot leave it below what was paid", async () => {
    const asNet = await charge("none", "amount", 100_000);
    const factura = await invoice(100_000);
    await ok(apply(factura, [{ charge_id: asNet, amount: 100_000, entered_as: "net" }]));
    expect(await chargeRow(asNet)).toMatchObject({ amount: 119_000, net_amount: 100_000 });

    const paid = await charge("none", "amount", 100_000);
    await ok(
      member.rpc("record_technician_payment", {
        p_personnel_id: ids.tech,
        p_payment_date: "2026-06-20",
        p_amount: 100_000,
        p_method: null,
        p_notes: null,
        p_applications: [{ charge_id: paid, amount: 100_000 }],
      }),
    );
    const boleta = await invoice(100_000, "BOL-HE", ids.personal);
    expect(await fails(apply(boleta, [{ charge_id: paid, amount: 84_750, entered_as: "gross" }], true))).toMatch(/ya tiene pagado/);
    // Refused whole: it is still sin respaldo.
    expect((await chargeRow(paid)).backing).toBe("none");
  });

  it("refuses another backing, another technician, a repeated charge and a document without technician", async () => {
    const boletaCharge = await charge("boleta", "gross", 100_000);
    const foreign = await charge("factura", "net", 100_000, 0, ids.otherTech);
    const mine = await charge("factura", "net", 100_000);
    const document = await invoice(100_000);
    expect(await fails(apply(document, [{ charge_id: boletaCharge, amount: 100_000 }]))).toMatch(/^CHARGES: .*otro respaldo/);
    expect(await fails(apply(document, [{ charge_id: foreign, amount: 100_000 }]))).toMatch(/^CHARGES: .*del técnico del documento/);
    expect(
      await fails(apply(document, [{ charge_id: mine, amount: 50_000 }, { charge_id: mine, amount: 50_000 }])),
    ).toMatch(/^CHARGES: Hay un cargo repetido/);
    expect(await fails(apply(document, []))).toMatch(/^CHARGES: /);
    const notTechnician = await invoice(100_000, "FAC-EL", ids.other);
    expect(await fails(apply(notTechnician, [{ charge_id: mine, amount: 100_000 }]))).toMatch(/^NO_TECHNICIAN: /);
  });

  it("replaces a split only when asked, and the split was on the net", async () => {
    const id = await charge("factura", "net", 100_000);
    const document = await invoice(100_000);
    await ok(
      member.rpc("set_cost_allocations", {
        p_cost_document_id: document,
        p_allocations: [
          { target_type: "project", target_id: jobs[0], method: "fixed_amount", value: 60_000 },
          { target_type: "project", target_id: jobs[1], method: "fixed_amount", value: 40_000 },
        ],
      }),
    );
    expect(await fails(apply(document, [{ charge_id: id, amount: 100_000 }]))).toMatch(/^ALLOCATED: /);
    await ok(apply(document, [{ charge_id: id, amount: 100_000 }], false, true));
    const left = await ok<unknown[]>(db.from("cost_allocations").select("id").eq("cost_document_id", document));
    expect(left).toEqual([]);
  });
});
