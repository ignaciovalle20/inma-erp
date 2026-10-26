/**
 * Técnicos externos, Chile: backing of each charge and the link between a
 * charge and its factura / boleta (20261026010000), against the real
 * inma-erp-dev project as a signed-in member (RLS on). All names invented.
 *
 * The cases of the request, in order:
 *  1. Boleta: líquido 375.000 in 2026 -> bruto 442.478, retención 67.478; the
 *     same from the bruto.
 *  2. Factura: net 100.000 -> total 119.000; total 119.000 -> net 100.000.
 *  3. Sin respaldo: cost = what is paid, document "no aplica", never pending.
 *  4. A factura of net 300.000 linked to 3 charges of 3 jobs (100.000 each):
 *     each job costs 100.000, the month's total is the one before importing
 *     the factura, the charges are "recibida".
 *  5. A document assigned by hand to a job: the link asks, then replaces it.
 *  6. Amounts that don't add up: no link, the difference is said.
 *  7. Unlinking brings the charges' own costs back; the document is a general
 *     cost again, unassigned.
 *  8. A boleta whose bruto is the sum of 2 pending charges is suggested; with
 *     two possible combinations nothing is.
 *  9. A technician with 2 RUTs: documents of both are recognized.
 * 10. Uruguay: charges and their document toggle work as before.
 * 11. Every existing charge still matches its own cost (the migration
 *     changed no amount).
 *
 * Run with `npm run test:integration`.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { anonClient, assertDevProject, serviceClient } from "./devProject";
import { purchaseRowCells, resolvePurchaseRow, type PurchaseColumnMapping } from "@/lib/purchaseImport";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let memberClient: SupabaseClient | null = null;
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    if (!memberClient) throw new Error("member client not ready");
    return memberClient;
  },
}));

import { computeMonthlyResult, computeProjectProfitability } from "@/lib/reporting";
import { getDocumentLinkContext, getTechnicianAccount } from "@/lib/technicianDal";
import { suggestTechnicianDocuments } from "@/lib/technicianDocumentSuggestions";
import { summarizeByTechnician } from "@/lib/technicians";

const tag = `TEST_TECHDOCS ${randomUUID().slice(0, 6)}`;
const PERIOD = "2026-10-01";
const db = serviceClient();
const ids = {
  cl: "",
  uy: "",
  user: "",
  tech: "",
  techUy: "",
  supplierA: "",
  supplierB: "",
  projects: [] as string[],
  projectUy: "",
};
let member: SupabaseClient;

type Charge = {
  id: string;
  amount: number;
  net_amount: number;
  backing: string | null;
  entered_as: string | null;
  withholding_rate: number | null;
  document_status: string;
  cost_document_id: string | null;
  vat_included: boolean;
};

async function ok<T = unknown>(p: PromiseLike<{ data: unknown; error: unknown }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(JSON.stringify(error));
  return data as T;
}

async function fails(p: PromiseLike<{ error: { message: string } | null }>): Promise<string> {
  const { error } = await p;
  if (!error) throw new Error("expected the database to refuse");
  return error.message;
}

function backedCharge(projectIndex: number, backing: string, enteredAs: string, value: number, date = "2026-10-05") {
  return ok<Charge>(
    member
      .rpc("create_backed_technician_charge", {
        p_project_id: ids.projects[projectIndex],
        p_personnel_id: ids.tech,
        p_description: `${tag} cargo`,
        p_charge_date: date,
        p_backing: backing,
        p_entered_as: enteredAs,
        p_value: value,
      })
      .single(),
  );
}

async function chargeRow(id: string): Promise<Charge> {
  return ok<Charge>(member.from("technician_charges").select("*").eq("id", id).single());
}

const MAPPING: PurchaseColumnMapping = {
  amount: "Neto",
  exempt: "Exento",
  tax: "IVA",
  otherTaxes: "Otros impuestos",
  total: "Total",
  documentType: "Tipo documento",
  documentNumber: "Nº documento",
  status: "Estado",
};

/** One Nubox purchase row through resolvePurchaseRow and import_cost_rows_batch; returns the document id. */
async function importDocument(
  supplierId: string,
  doc: { type: string; number: string; net: number; tax: number; total: number; date?: string },
): Promise<string> {
  const row = {
    "Fecha emisión": "20/10/2026",
    "Tipo documento": doc.type,
    "Nº documento": doc.number,
    Proveedor: "x",
    Neto: String(doc.net),
    Exento: "0",
    IVA: String(doc.tax),
    "Otros impuestos": "0",
    Total: String(doc.total),
    Estado: "Aceptado",
  };
  const { amounts, error } = resolvePurchaseRow(purchaseRowCells(row, MAPPING));
  if (!amounts) throw new Error(error ?? "row not read");
  const batch = await ok<{ id: string }>(
    member.rpc("create_cost_import_batch", { p_company_id: ids.cl, p_file_name: `${tag}.csv`, p_total_rows: 1 }),
  );
  const [result] = await ok<{ status: string; error_message: string | null; cost_document_id: string | null }[]>(
    member.rpc("import_cost_rows_batch", {
      p_import_batch_id: batch.id,
      p_rows: [
        {
          row_number: 1,
          raw_data: row,
          supplier_id: supplierId,
          document_date: doc.date ?? "2026-10-20",
          currency: "CLP",
          amount: amounts.netAmount,
          exempt_amount: amounts.exemptAmount,
          tax_amount: amounts.taxAmount,
          other_taxes: amounts.otherTaxes,
          document_type: amounts.documentType,
          source_document_type: amounts.sourceDocumentType,
          document_number: amounts.documentNumber,
          force: false,
          link_to_cost_document_id: null,
        },
      ],
    }),
  );
  if (result.status !== "imported" || !result.cost_document_id) throw new Error(JSON.stringify(result));
  return result.cost_document_id;
}

async function monthTotalCosts(): Promise<number> {
  const month = await computeMonthlyResult(ids.cl, PERIOD);
  expect(month.hasError).toBe(false);
  return month.directCosts + month.generalCosts;
}

async function projectCost(index: number): Promise<number> {
  return (await computeProjectProfitability(ids.cl, ids.projects[index], PERIOD)).costs;
}

beforeAll(async () => {
  assertDevProject();
  const cl = await ok<{ id: string }>(db.from("companies").insert({ name: `${tag} CL`, country: "CL", currency: "CLP" }).select("id").single());
  const uy = await ok<{ id: string }>(db.from("companies").insert({ name: `${tag} UY`, country: "UY", currency: "UYU" }).select("id").single());
  ids.cl = cl.id;
  ids.uy = uy.id;

  const email = `test_techdocs_${randomUUID().slice(0, 6)}@example.test`;
  const password = randomBytes(24).toString("base64url");
  const { data: user, error } = await db.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  ids.user = user.user.id;
  await ok(
    db
      .from("company_memberships")
      .insert([
        { user_id: ids.user, company_id: ids.cl, role: "admin" },
        { user_id: ids.user, company_id: ids.uy, role: "admin" },
      ])
      .select("id"),
  );
  member = anonClient();
  const { error: signInError } = await member.auth.signInWithPassword({ email, password });
  if (signInError) throw signInError;
  memberClient = member;

  for (const company of [ids.cl, ids.uy]) {
    const client = await ok<{ id: string }>(db.from("clients").insert({ company_id: company, name: `${tag} cliente` }).select("id").single());
    const area = await ok<{ id: string }>(db.from("business_areas").insert({ company_id: company, name: `${tag} area` }).select("id").single());
    const count = company === ids.cl ? 4 : 1;
    for (let n = 1; n <= count; n++) {
      const project = await ok<{ id: string }>(
        db
          .from("projects")
          .insert({ company_id: company, client_id: client.id, business_area_id: area.id, name: `${tag} trabajo ${n}`, status: "en_ejecucion" })
          .select("id")
          .single(),
      );
      if (company === ids.cl) ids.projects.push(project.id);
      else ids.projectUy = project.id;
    }
  }

  const tech = await ok<{ id: string }>(
    member
      .from("personnel")
      .insert({ company_id: ids.cl, name: `${tag} Juan Pérez`, type: "contractor", tax_id: "12.345.678-5", default_backing: "factura" })
      .select("id")
      .single(),
  );
  ids.tech = tech.id;
  const techUy = await ok<{ id: string }>(
    member
      .from("personnel")
      .insert({ company_id: ids.uy, name: `${tag} Técnico UY`, type: "contractor", payment_document: "factura" })
      .select("id")
      .single(),
  );
  ids.techUy = techUy.id;
}, 120_000);

afterAll(async () => {
  const failures: unknown[] = [];
  const step = async (p: PromiseLike<{ error: unknown }>) => {
    const { error } = await p;
    if (error) failures.push(error);
  };
  memberClient = null;
  for (const company of [ids.cl, ids.uy].filter(Boolean)) {
    // Links are undone through their RPC (a bare delete is refused, even to the service role).
    const linked = ((await db.from("technician_charge_documents").select("cost_document_id").eq("company_id", company)).data ?? []).map(
      (row) => row.cost_document_id as string,
    );
    for (const documentId of new Set(linked)) await step(member.rpc("unlink_technician_document", { p_cost_document_id: documentId }));
    await step(db.from("technician_document_suggestions").delete().eq("company_id", company));
    await step(db.from("technician_payments").delete().eq("company_id", company));
    await step(db.from("technician_charges").delete().eq("company_id", company));
    const costDocs = ((await db.from("cost_documents").select("id").eq("company_id", company)).data ?? []).map((row) => row.id);
    const batches = ((await db.from("cost_import_batches").select("id").eq("company_id", company)).data ?? []).map((row) => row.id);
    if (costDocs.length) {
      await step(db.from("cost_allocations").delete().in("cost_document_id", costDocs));
      await step(db.from("cost_documents").update({ import_row_id: null, duplicate_of_cost_document_id: null }).in("id", costDocs));
      await step(db.from("cost_lines").delete().in("cost_document_id", costDocs));
    }
    if (batches.length) await step(db.from("cost_import_rows").delete().in("import_batch_id", batches));
    await step(db.from("cost_documents").delete().eq("company_id", company));
    await step(db.from("cost_import_batches").delete().eq("company_id", company));
    await step(db.from("technician_suppliers").delete().eq("company_id", company));
    await step(db.from("suppliers").delete().eq("company_id", company));
    await step(db.from("personnel").delete().eq("company_id", company));
    await step(db.from("projects").delete().eq("company_id", company));
    await step(db.from("clients").delete().eq("company_id", company));
    await step(db.from("business_areas").delete().eq("company_id", company));
    await step(db.from("company_memberships").delete().eq("company_id", company));
    await step(db.from("companies").delete().eq("id", company));
  }
  if (ids.user) {
    const { error } = await db.auth.admin.deleteUser(ids.user);
    if (error) failures.push(error);
  }
  if (failures.length) throw new Error(`cleanup failed (${tag}): ${JSON.stringify(failures)}`);
}, 180_000);

describe("technician backing and documents (Chile)", () => {
  const charges = { f1: "", f2: "", f3: "", b1: "", b2: "", b3: "", b4: "", none: "" };
  const docs = { factura300: "", factura100: "", factura150: "", boleta500: "", boleta100: "" };

  it("9. links the technician's RUTs: the one created with their RUT by itself, a second one from the ficha", async () => {
    const supplierA = await ok<{ id: string }>(
      member.from("suppliers").insert({ company_id: ids.cl, name: `${tag} Juan Pérez`, tax_id: "12345678-5" }).select("id").single(),
    );
    ids.supplierA = supplierA.id;
    const links = await ok<{ id: string; supplier_id: string; personnel_id: string }[]>(
      member.rpc("link_technician_tax_id", { p_personnel_id: ids.tech, p_tax_id: "76.543.210-k", p_supplier_name: `${tag} Pérez SpA` }),
    );
    ids.supplierB = links[0].supplier_id;

    const all = await ok<{ supplier_id: string; personnel_id: string }[]>(
      member.from("technician_suppliers").select("supplier_id, personnel_id").eq("company_id", ids.cl),
    );
    expect(new Set(all.map((row) => row.supplier_id))).toEqual(new Set([ids.supplierA, ids.supplierB]));
    expect(all.every((row) => row.personnel_id === ids.tech)).toBe(true);
    const supplierB = await ok<{ tax_id: string; name: string }>(member.from("suppliers").select("tax_id, name").eq("id", ids.supplierB).single());
    expect(supplierB).toEqual({ tax_id: "76.543.210-k", name: `${tag} Pérez SpA` });

    // The same RUT typed another way finds the same supplier, no duplicate.
    await ok(member.rpc("link_technician_tax_id", { p_personnel_id: ids.tech, p_tax_id: "76543210K", p_supplier_name: null }));
    const suppliers = await ok<unknown[]>(member.from("suppliers").select("id").eq("company_id", ids.cl));
    expect(suppliers).toHaveLength(2);
  });

  it("1. boleta: líquido 375.000 in 2026 is bruto 442.478 and retención 67.478; from the bruto, the same", async () => {
    const fromLiquid = await backedCharge(0, "boleta", "liquid", 375000);
    expect(fromLiquid).toMatchObject({
      amount: 375000,
      net_amount: 442478,
      backing: "boleta",
      entered_as: "liquid",
      withholding_rate: 0.1525,
      document_status: "pendiente",
    });
    expect(fromLiquid.net_amount - fromLiquid.amount).toBe(67478);
    const own = await ok<{ net_amount: number; total_amount: number; tax_amount: number; project_id: string; classification: string }>(
      member.from("cost_documents").select("net_amount, total_amount, tax_amount, project_id, classification").eq("id", fromLiquid.cost_document_id!).single(),
    );
    expect(own).toEqual({ net_amount: 442478, total_amount: 442478, tax_amount: 0, project_id: ids.projects[0], classification: "direct" });

    const fromGross = await ok<Charge>(
      member
        .rpc("update_backed_technician_charge", {
          p_charge_id: fromLiquid.id,
          p_description: null,
          p_charge_date: "2026-10-05",
          p_backing: "boleta",
          p_entered_as: "gross",
          p_value: 442478,
        })
        .single(),
    );
    expect(fromGross).toMatchObject({ amount: 375000, net_amount: 442478, entered_as: "gross" });
    await ok(member.rpc("delete_technician_charge", { p_charge_id: fromLiquid.id }));
  });

  it("2. factura: net 100.000 is total 119.000, and total 119.000 is net 100.000", async () => {
    const fromNet = await backedCharge(0, "factura", "net", 100000);
    expect(fromNet).toMatchObject({ amount: 119000, net_amount: 100000, vat_included: true, document_status: "pendiente" });
    const fromTotal = await ok<Charge>(
      member
        .rpc("update_backed_technician_charge", {
          p_charge_id: fromNet.id,
          p_description: null,
          p_charge_date: "2026-10-05",
          p_backing: "factura",
          p_entered_as: "total",
          p_value: 119000,
        })
        .single(),
    );
    expect(fromTotal).toMatchObject({ amount: 119000, net_amount: 100000 });
    charges.f1 = fromNet.id;
  });

  it("3. sin respaldo: cost = what is paid, document no aplica, never pending", async () => {
    const none = await backedCharge(3, "none", "amount", 85000);
    expect(none).toMatchObject({ amount: 85000, net_amount: 85000, backing: "none", document_status: "no_aplica" });
    charges.none = none.id;
    // Its document cannot be marked by hand, and it is not a pending document.
    expect(await fails(member.rpc("set_technician_charge_document", { p_charge_id: none.id, p_document_status: "recibida" }))).toMatch(
      /vinculando la factura o boleta/,
    );
    const { charges: account } = await getTechnicianAccount(ids.cl, ids.tech);
    expect(summarizeByTechnician(account).get(ids.tech)?.pendingDocuments).toBe(1); // only the factura of case 2
  });

  it("4. a factura of 300.000 linked to 3 charges of 3 jobs: 100.000 each, the month's total as before the factura", async () => {
    charges.f2 = (await backedCharge(1, "factura", "net", 100000, "2026-10-06")).id;
    charges.f3 = (await backedCharge(2, "factura", "net", 100000, "2026-10-07")).id;
    const before = await monthTotalCosts();

    docs.factura300 = await importDocument(ids.supplierB, { type: "FAC-EL", number: "9301", net: 300000, tax: 57000, total: 357000 });
    expect(await monthTotalCosts()).toBe(before + 300000); // the duplicate the link removes

    const ownBefore = await Promise.all([charges.f1, charges.f2, charges.f3].map(chargeRow));
    const result = await ok<{ charges: number; projects: number }>(
      member.rpc("link_technician_document", {
        p_cost_document_id: docs.factura300,
        p_charge_ids: [charges.f1, charges.f2, charges.f3],
        p_replace_allocations: false,
      }),
    );
    expect(result).toMatchObject({ charges: 3, projects: 3 });

    expect(await monthTotalCosts()).toBe(before);
    for (const index of [0, 1, 2]) expect(await projectCost(index)).toBeCloseTo(100000, 6);

    // The charges keep their own costs (job and month of the charge); the factura only backs them (20261028010000).
    const after = await Promise.all([charges.f1, charges.f2, charges.f3].map(chargeRow));
    for (const [index, charge] of after.entries()) {
      expect(charge).toMatchObject({
        document_status: "recibida",
        cost_document_id: ownBefore[index].cost_document_id,
        amount: 119000,
        net_amount: 100000,
      });
    }
    const backing = await ok<{ classification: string; project_id: string | null; technician_linked_amount: number }>(
      member.from("cost_documents").select("classification, project_id, technician_linked_amount").eq("id", docs.factura300).single(),
    );
    expect(backing).toEqual({ classification: "general", project_id: null, technician_linked_amount: 300000 });

    // 9: a document of the second RUT is recognized as the technician's.
    const context = await getDocumentLinkContext(ids.cl, docs.factura300);
    expect(context.technician?.id).toBe(ids.tech);
    expect(context.linkedCharges.map((charge) => charge.id).sort()).toEqual([charges.f1, charges.f2, charges.f3].sort());

    // While linked: no other assignment, and the charge keeps its amounts.
    expect(
      await fails(
        member.rpc("set_cost_document_allocations", {
          p_cost_document_id: docs.factura300,
          p_allocations: [
            { target_type: "project", target_id: ids.projects[3], method: "fixed_amount", value: 178500, position: 0 },
            { target_type: "project", target_id: ids.projects[0], method: "fixed_amount", value: 178500, position: 1 },
          ],
          p_service_allocations: [],
        }),
      ),
    ).toMatch(/Vinculada a cargos de técnico/);
    expect(await fails(member.rpc("delete_technician_charge", { p_charge_id: charges.f1 }))).toMatch(/vinculado a un documento/);
    expect(
      await fails(
        member.rpc("update_backed_technician_charge", {
          p_charge_id: charges.f1,
          p_description: null,
          p_charge_date: "2026-10-05",
          p_backing: "factura",
          p_entered_as: "net",
          p_value: 90000,
        }),
      ),
    ).toMatch(/vinculado a un documento/);
  });

  it("7. unlinking brings back each charge's own cost; the document is a general cost, unassigned", async () => {
    await ok(member.rpc("unlink_technician_document", { p_cost_document_id: docs.factura300 }));
    for (const id of [charges.f1, charges.f2, charges.f3]) {
      const charge = await chargeRow(id);
      expect(charge.document_status).toBe("pendiente");
      const own = await ok<{ net_amount: number; total_amount: number; classification: string }>(
        member.from("cost_documents").select("net_amount, total_amount, classification").eq("id", charge.cost_document_id!).single(),
      );
      expect(own).toEqual({ net_amount: 100000, total_amount: 119000, classification: "direct" });
    }
    const document = await ok<{ classification: string; project_id: string | null; cost_allocations: unknown[] }>(
      member.from("cost_documents").select("classification, project_id, cost_allocations(id)").eq("id", docs.factura300).single(),
    );
    expect(document).toEqual({ classification: "general", project_id: null, cost_allocations: [] });
    for (const index of [0, 1, 2]) expect(await projectCost(index)).toBeCloseTo(100000, 6);
  });

  it("5. a document assigned by hand to the job: the link asks first, then replaces it (no duplicate)", async () => {
    docs.factura100 = await importDocument(ids.supplierA, { type: "FAC-EL", number: "77", net: 100000, tax: 19000, total: 119000 });
    await ok(member.rpc("assign_cost_document_to_project", { p_cost_document_id: docs.factura100, p_project_id: ids.projects[0] }));
    expect(await projectCost(0)).toBeCloseTo(200000, 6); // today's duplicate

    expect(
      await fails(member.rpc("link_technician_document", { p_cost_document_id: docs.factura100, p_charge_ids: [charges.f1], p_replace_allocations: false })),
    ).toMatch(/^ALLOCATED: /);
    await ok(member.rpc("link_technician_document", { p_cost_document_id: docs.factura100, p_charge_ids: [charges.f1], p_replace_allocations: true }));

    expect(await projectCost(0)).toBeCloseTo(100000, 6);
    // While linked it cannot be assigned anywhere.
    expect(await fails(member.from("cost_documents").update({ project_id: ids.projects[3] }).eq("id", docs.factura100))).toMatch(
      /Vinculada a cargos de técnico/,
    );
    // The hand assignment is gone: the factura backs the charge, a general cost counted 0.
    const document = await ok<{ classification: string; project_id: string | null }>(
      member.from("cost_documents").select("classification, project_id").eq("id", docs.factura100).single(),
    );
    expect(document).toEqual({ classification: "general", project_id: null });
  });

  it("6. amounts that don't add up: no link, and the difference is said", async () => {
    docs.factura150 = await importDocument(ids.supplierB, { type: "FAC-EL", number: "9302", net: 150000, tax: 28500, total: 178500 });
    const message = await fails(
      member.rpc("link_technician_document", { p_cost_document_id: docs.factura150, p_charge_ids: [charges.f2], p_replace_allocations: false }),
    );
    expect(message).toMatch(/^AMOUNT_MISMATCH: /);
    expect(message).toMatch(/diferencia 50000/);
    expect((await chargeRow(charges.f2)).cost_document_id).not.toBeNull();
  });

  it("8. suggests the boleta whose bruto is the sum of 2 pending charges, and nothing with two combinations", async () => {
    charges.b1 = (await backedCharge(1, "boleta", "gross", 200000, "2026-10-08")).id;
    charges.b2 = (await backedCharge(2, "boleta", "gross", 300000, "2026-10-09")).id;
    docs.boleta500 = await importDocument(ids.supplierA, { type: "BOL-HE", number: "15", net: 500000, tax: 0, total: 423750 });

    const first = await suggestTechnicianDocuments(member, ids.cl, { documentIds: [docs.boleta500] });
    expect(first).toEqual({ created: 1, error: null });
    const suggestion = await ok<{ charge_ids: string[]; status: string }>(
      member.from("technician_document_suggestions").select("charge_ids, status").eq("cost_document_id", docs.boleta500).single(),
    );
    expect(new Set(suggestion.charge_ids)).toEqual(new Set([charges.b1, charges.b2]));
    expect(suggestion.status).toBe("pending");

    charges.b3 = (await backedCharge(3, "boleta", "gross", 100000, "2026-10-10")).id;
    charges.b4 = (await backedCharge(3, "boleta", "gross", 100000, "2026-10-11")).id;
    docs.boleta100 = await importDocument(ids.supplierA, { type: "BOL-HE", number: "16", net: 100000, tax: 0, total: 84750, date: "2026-10-21" });
    expect(await suggestTechnicianDocuments(member, ids.cl, { documentIds: [docs.boleta100] })).toEqual({ created: 0, error: null });

    // Running it again never duplicates a suggestion.
    expect(await suggestTechnicianDocuments(member, ids.cl, {})).toEqual({ created: 0, error: null });

    // Confirming it (what Conciliar does) links it and settles the suggestion.
    await ok(
      member.rpc("link_technician_document", { p_cost_document_id: docs.boleta500, p_charge_ids: suggestion.charge_ids, p_replace_allocations: false }),
    );
    const left = await ok<unknown[]>(member.from("technician_document_suggestions").select("id").eq("cost_document_id", docs.boleta500));
    expect(left).toHaveLength(0);
    expect(await projectCost(1)).toBeCloseTo(100000 + 200000, 6);
    expect(await projectCost(2)).toBeCloseTo(100000 + 300000, 6);
  });

  it("deleting a linked document unlinks it first: the charges' own costs come back", async () => {
    const result = await ok<{ unlinked_charges: number }>(member.rpc("delete_cost_document", { p_cost_document_id: docs.boleta500 }));
    expect(result.unlinked_charges).toBe(2);
    for (const id of [charges.b1, charges.b2]) {
      const charge = await chargeRow(id);
      expect(charge.document_status).toBe("pendiente");
      expect(charge.cost_document_id).not.toBeNull();
    }
    expect(await projectCost(1)).toBeCloseTo(100000 + 200000, 6);
  });

  it("10. Uruguay: charges and the document toggle work as before; no backing, no RUT links", async () => {
    const charge = await ok<Charge>(
      member
        .rpc("create_technician_charge", {
          p_project_id: ids.projectUy,
          p_personnel_id: ids.techUy,
          p_description: `${tag} visita`,
          p_charge_date: "2026-10-05",
          p_amount: 12200,
          p_vat_included: true,
          p_vat_rate: 0.22,
        })
        .single(),
    );
    expect(charge).toMatchObject({ amount: 12200, net_amount: 10000, backing: null, document_status: "pendiente" });
    const received = await ok<Charge>(
      member.rpc("set_technician_charge_document", { p_charge_id: charge.id, p_document_status: "recibida" }).single(),
    );
    expect(received.document_status).toBe("recibida");
    const corrected = await ok<Charge>(
      member
        .rpc("update_technician_charge", {
          p_charge_id: charge.id,
          p_description: null,
          p_charge_date: "2026-10-05",
          p_amount: 24400,
          p_vat_included: true,
          p_vat_rate: 0.22,
        })
        .single(),
    );
    expect(corrected).toMatchObject({ amount: 24400, net_amount: 20000 });

    expect(
      await fails(
        member.rpc("create_backed_technician_charge", {
          p_project_id: ids.projectUy,
          p_personnel_id: ids.techUy,
          p_description: null,
          p_charge_date: "2026-10-05",
          p_backing: "factura",
          p_entered_as: "net",
          p_value: 1000,
        }),
      ),
    ).toMatch(/solo en empresas de Chile/);
    expect(await fails(member.rpc("link_technician_tax_id", { p_personnel_id: ids.techUy, p_tax_id: "211234560019", p_supplier_name: null }))).toMatch(
      /solo en empresas de Chile/,
    );
  });

  it("11. every charge of the database still matches its own cost, or has its document linked", async () => {
    const all = await ok<
      {
        id: string;
        amount: number;
        net_amount: number;
        backing: string | null;
        cost_document_id: string | null;
        cost_documents: { net_amount: number; total_amount: number } | null;
        technician_charge_documents: { id: string }[] | { id: string } | null;
      }[]
    >(
      db
        .from("technician_charges")
        .select("id, amount, net_amount, backing, cost_document_id, cost_documents (net_amount, total_amount), technician_charge_documents (id)"),
    );
    expect(all.length).toBeGreaterThan(0);
    // 20261028010000: every charge keeps its own cost, linked or not.
    for (const charge of all) {
      expect(charge.cost_document_id).not.toBeNull();
      expect(Number(charge.cost_documents?.net_amount)).toBe(Number(charge.net_amount));
      expect(Number(charge.cost_documents?.total_amount)).toBe(
        Number(charge.backing === "boleta" ? charge.net_amount : charge.amount),
      );
    }
  });
});
