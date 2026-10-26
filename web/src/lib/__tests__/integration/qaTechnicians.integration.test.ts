/**
 * QA of 2026-10-27 (docs/qa-tecnicos-2026-10-27.md) of the technicians'
 * backing and document links (20261026010000, 20261027010000), against the
 * real inma-erp-dev project as signed-in members (RLS on). Every name starts
 * with "QA-" and everything is deleted in afterAll. Each scenario uses its own
 * month (or its own technician) so their costs and suggestions never mix.
 *
 * Run with `npm run test:integration`.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { anonClient, assertDevProject, runLinkedSql, serviceClient } from "./devProject";
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

import { computeMonthlyResult, getProfitabilityBreakdown } from "@/lib/reporting";
import { getTechnicianAccount, getTechnicianCharges } from "@/lib/technicianDal";
import { suggestTechnicianDocuments } from "@/lib/technicianDocumentSuggestions";
import { backedChargeAmounts, summarizeByProject, summarizeByTechnician, type Backing, type EnteredAs } from "@/lib/technicians";
import { executeTool } from "@/lib/ai/tools";
import { resolveTechnicianSuggestions } from "@/app/companies/[id]/sales/reconcile/actions";

const tag = `QA-${randomUUID().slice(0, 6)}`;
const db = serviceClient();

type Charge = {
  id: string;
  amount: number;
  net_amount: number;
  backing: string | null;
  withholding_rate: number | null;
  document_status: string;
  cost_document_id: string | null;
  project_id: string;
};

const ids = {
  cl: "",
  other: "",
  uy: "",
  users: [] as string[],
  clients: [] as string[],
  areas: [] as string[],
  jobs: [] as string[],
  otherJob: "",
  uyJob: "",
  techs: {} as Record<string, string>,
  suppliers: {} as Record<string, string>,
  otherTech: "",
  uyTech: "",
  service: "",
  servicePeriod: "",
};
let member: SupabaseClient;
let outsider: SupabaseClient;

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

async function signedIn(email: string, password: string): Promise<SupabaseClient> {
  const client = anonClient();
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return client;
}

async function newUser(suffix: string, companies: string[]): Promise<SupabaseClient> {
  const email = `${tag.toLowerCase()}-${suffix}@example.test`;
  const password = randomBytes(24).toString("base64url");
  const { data, error } = await db.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  ids.users.push(data.user.id);
  if (companies.length > 0) {
    await ok(db.from("company_memberships").insert(companies.map((company_id) => ({ user_id: data.user.id, company_id, role: "admin" }))).select("id"));
  }
  return signedIn(email, password);
}

/** A technician of the company with a RUT (its supplier is created by link_technician_tax_id). */
async function technician(key: string, rut: string, backing: Backing = "factura", company = ids.cl): Promise<string> {
  const tech = await ok<{ id: string }>(
    member
      .from("personnel")
      .insert({ company_id: company, name: `${tag} Técnico ${key}`, type: "contractor", default_backing: backing })
      .select("id")
      .single(),
  );
  ids.techs[key] = tech.id;
  const links = await ok<{ supplier_id: string }[]>(
    member.rpc("link_technician_tax_id", { p_personnel_id: tech.id, p_tax_id: rut, p_supplier_name: `${tag} Proveedor ${key}` }),
  );
  ids.suppliers[key] = links[0].supplier_id;
  return tech.id;
}

function charge(
  tech: string,
  job: string,
  backing: Backing,
  enteredAs: EnteredAs,
  value: number,
  date: string,
): Promise<Charge> {
  return ok<Charge>(
    member
      .rpc("create_backed_technician_charge", {
        p_project_id: job,
        p_personnel_id: tech,
        p_description: `${tag} cargo`,
        p_charge_date: date,
        p_backing: backing,
        p_entered_as: enteredAs,
        p_value: value,
      })
      .single(),
  );
}

function chargeRow(id: string): Promise<Charge> {
  return ok<Charge>(member.from("technician_charges").select("*").eq("id", id).single());
}

function link(document: string, charges: string[], replace = false) {
  return member.rpc("link_technician_document", { p_cost_document_id: document, p_charge_ids: charges, p_replace_allocations: replace });
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

type Row = { type: string; number: string; net: number; tax?: number; total?: number; date: string };

/** Nubox purchase rows of one supplier, through resolvePurchaseRow and import_cost_rows_batch. */
async function importRows(supplierId: string, rows: Row[]) {
  const batch = await ok<{ id: string }>(
    member.rpc("create_cost_import_batch", { p_company_id: ids.cl, p_file_name: `${tag}.csv`, p_total_rows: rows.length }),
  );
  const payload = rows.map((row, index) => {
    const raw = {
      "Fecha emisión": row.date,
      "Tipo documento": row.type,
      "Nº documento": row.number,
      Proveedor: "x",
      Neto: String(row.net),
      Exento: "0",
      IVA: String(row.tax ?? 0),
      "Otros impuestos": "0",
      Total: String(row.total ?? row.net + (row.tax ?? 0)),
      Estado: "Aceptado",
    };
    const { amounts, error } = resolvePurchaseRow(purchaseRowCells(raw, MAPPING));
    if (!amounts) throw new Error(error ?? "row not read");
    return {
      row_number: index + 1,
      raw_data: raw,
      supplier_id: supplierId,
      document_date: row.date,
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
    };
  });
  return ok<{ status: string; cost_document_id: string | null }[]>(
    member.rpc("import_cost_rows_batch", { p_import_batch_id: batch.id, p_rows: payload }),
  );
}

async function importDocument(supplierId: string, row: Row): Promise<string> {
  const [result] = await importRows(supplierId, [row]);
  if (result.status !== "imported" || !result.cost_document_id) throw new Error(JSON.stringify(result));
  return result.cost_document_id;
}

const factura = (number: string, net: number, date: string): Row => ({
  type: "FAC-EL",
  number,
  net,
  tax: Math.round(net * 0.19),
  date,
});
const boleta = (number: string, gross: number, net: number, date: string): Row => ({
  type: "BOL-HE",
  number,
  net: gross,
  total: net,
  date,
});

async function month(period: string) {
  const result = await computeMonthlyResult(ids.cl, period);
  expect(result.hasError).toBe(false);
  return result;
}

async function breakdown(period: string) {
  const result = await getProfitabilityBreakdown(ids.cl, period);
  expect(result.hasError).toBe(false);
  const pick = (rows: { id: string; costs: number; margin: number }[], wanted: string[]) =>
    Object.fromEntries(wanted.map((id) => [id, { costs: rows.find((row) => row.id === id)?.costs ?? 0, margin: rows.find((row) => row.id === id)?.margin ?? 0 }]));
  return {
    projects: pick(result.projects, ids.jobs),
    clients: pick(result.clients, ids.clients),
    areas: pick(result.areas, ids.areas),
  };
}

beforeAll(async () => {
  assertDevProject();
  const company = async (name: string, country: string, currency: string) =>
    (await ok<{ id: string }>(db.from("companies").insert({ name, country, currency }).select("id").single())).id;
  ids.cl = await company(`${tag} CL`, "CL", "CLP");
  ids.other = await company(`${tag} CL otra`, "CL", "CLP");
  ids.uy = await company(`${tag} UY`, "UY", "UYU");

  member = await newUser("miembro", [ids.cl, ids.other, ids.uy]);
  outsider = await newUser("ajeno", []);
  memberClient = member;

  for (const n of [1, 2]) {
    ids.clients.push((await ok<{ id: string }>(db.from("clients").insert({ company_id: ids.cl, name: `${tag} cliente ${n}` }).select("id").single())).id);
    ids.areas.push((await ok<{ id: string }>(db.from("business_areas").insert({ company_id: ids.cl, name: `${tag} area ${n}` }).select("id").single())).id);
  }
  // J1 (C1, A1), J2 (C1, A2), J3 (C2, A1), J4 (C2, A2), J5 and J6 (C1, A1).
  const layout = [
    [0, 0],
    [0, 1],
    [1, 0],
    [1, 1],
    [0, 0],
    [0, 0],
  ];
  for (const [index, [client, area]] of layout.entries()) {
    ids.jobs.push(
      (
        await ok<{ id: string }>(
          db
            .from("projects")
            .insert({ company_id: ids.cl, client_id: ids.clients[client], business_area_id: ids.areas[area], name: `${tag} trabajo ${index + 1}`, status: "en_ejecucion" })
            .select("id")
            .single(),
        )
      ).id,
    );
  }
  for (const [company, key] of [
    [ids.other, "otherJob"],
    [ids.uy, "uyJob"],
  ] as const) {
    const client = await ok<{ id: string }>(db.from("clients").insert({ company_id: company, name: `${tag} cliente` }).select("id").single());
    const area = await ok<{ id: string }>(db.from("business_areas").insert({ company_id: company, name: `${tag} area` }).select("id").single());
    ids[key] = (
      await ok<{ id: string }>(
        db.from("projects").insert({ company_id: company, client_id: client.id, business_area_id: area.id, name: `${tag} trabajo`, status: "en_ejecucion" }).select("id").single(),
      )
    ).id;
  }

  await technician("T1", "76.543.210-K");
  await technician("T2", "9.876.543-3");
  await technician("T3", "11.111.111-1", "none");

  const otherTech = await ok<{ id: string }>(
    member.from("personnel").insert({ company_id: ids.other, name: `${tag} Técnico otra`, type: "contractor", default_backing: "factura" }).select("id").single(),
  );
  ids.otherTech = otherTech.id;
  const uyTech = await ok<{ id: string }>(
    member.from("personnel").insert({ company_id: ids.uy, name: `${tag} Técnico UY`, type: "contractor", payment_document: "boleta_honorarios" }).select("id").single(),
  );
  ids.uyTech = uyTech.id;

  // A recurring service whose supplier is T1's company RUT, with a July cost period.
  const service = await ok<{ id: string }>(
    member
      .from("recurring_services")
      .insert({
        company_id: ids.cl,
        client_id: ids.clients[0],
        name: `${tag} soporte mensual`,
        currency: "CLP",
        reference_amount: 120000,
        periodicity: "monthly",
        invoicing_mode: "advance",
        start_date: "2026-07-01",
        end_date: "2026-07-31",
        service_type: "starlink",
        fixed_cost: 80000,
        cost_periodicity: "monthly",
        supplier_id: ids.suppliers.T1,
        status: "active",
        active: true,
      })
      .select("id")
      .single(),
  );
  ids.service = service.id;
  ids.servicePeriod = (
    await ok<{ id: string }>(db.from("recurring_service_cost_periods").select("id").eq("recurring_service_id", service.id).eq("period", "2026-07-01").single())
  ).id;
}, 240_000);

afterAll(async () => {
  const failures: unknown[] = [];
  const step = async (p: PromiseLike<{ error: unknown }>) => {
    const { error } = await p;
    if (error) failures.push(error);
  };
  for (const company of [ids.cl, ids.other, ids.uy].filter(Boolean)) {
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
      await step(db.from("cost_service_allocations").delete().in("cost_document_id", costDocs));
      await step(db.from("cost_allocations").delete().in("cost_document_id", costDocs));
      await step(db.from("cost_documents").update({ import_row_id: null, duplicate_of_cost_document_id: null }).in("id", costDocs));
      await step(db.from("cost_lines").delete().in("cost_document_id", costDocs));
    }
    if (batches.length) await step(db.from("cost_import_rows").delete().in("import_batch_id", batches));
    await step(db.from("cost_documents").delete().eq("company_id", company));
    await step(db.from("cost_import_batches").delete().eq("company_id", company));
    const services = ((await db.from("recurring_services").select("id").eq("company_id", company)).data ?? []).map((row) => row.id);
    if (services.length) {
      await step(db.from("recurring_service_cost_periods").delete().in("recurring_service_id", services));
      await step(db.from("recurring_service_occurrences").delete().in("recurring_service_id", services));
    }
    await step(db.from("recurring_services").delete().eq("company_id", company));
    await step(db.from("sales_documents").delete().eq("company_id", company));
    // A sale of a job without a quote gets a placeholder quote.
    await step(db.from("project_quotes").delete().eq("company_id", company));
    await step(db.from("technician_suppliers").delete().eq("company_id", company));
    await step(db.from("suppliers").delete().eq("company_id", company));
    await step(db.from("personnel").delete().eq("company_id", company));
    await step(db.from("projects").delete().eq("company_id", company));
    await step(db.from("clients").delete().eq("company_id", company));
    await step(db.from("business_areas").delete().eq("company_id", company));
    await step(db.from("company_memberships").delete().eq("company_id", company));
    await step(db.from("companies").delete().eq("id", company));
  }
  for (const user of ids.users) {
    const { error } = await db.auth.admin.deleteUser(user);
    if (error) failures.push(error);
  }
  memberClient = null;
  if (failures.length) throw new Error(`cleanup failed (${tag}): ${JSON.stringify(failures)}`);
}, 240_000);

describe("QA técnicos: cálculos", () => {
  it("1-2. the database computes exactly what the screen previews (every year, both ways, amounts that round)", () => {
    const values = [...Array.from({ length: 1500 }, (_, index) => index + 1), 9999, 100000, 375000, 442478, 999999, 1000001, 2345679];
    const list = `array[${values.join(",")}]`;
    // One packed row ("y,mode,v,payable,cost;…"): thousands of JSON rows overflow the CLI's output buffer.
    const [packed] = runLinkedSql<{ rows: string }>(
      `select string_agg(concat_ws(',', y, mode, v, (a).payable, (a).cost), ';') as rows
       from (
         select y, mode, v, public.technician_backing_amounts(case when mode in ('liquid','gross') then 'boleta' else 'factura' end, mode, v, make_date(y, 6, 1)) as a
         from unnest(array[2025, 2026, 2027, 2028]) y
         cross join unnest(array['liquid','gross','net','total']) mode
         cross join unnest(${list}) v
         where y = 2026 or mode in ('liquid','gross')
       ) t`,
    );
    const rows = packed.rows.split(";").map((entry) => {
      const [y, mode, v, payable, cost] = entry.split(",");
      return { y: Number(y), mode, v: Number(v), payable: Number(payable), cost: Number(cost) };
    });
    expect(rows.length).toBe(values.length * (4 * 2 + 2));
    const rates: Record<number, number> = { 2025: 0.145, 2026: 0.1525, 2027: 0.16, 2028: 0.17 };
    const mismatches = rows.filter((row) => {
      const backing = row.mode === "liquid" || row.mode === "gross" ? "boleta" : "factura";
      const preview = backedChargeAmounts({
        backing,
        enteredAs: row.mode as EnteredAs,
        value: Number(row.v),
        withholdingRate: backing === "boleta" ? rates[Number(row.y)] : null,
      });
      return !preview || preview.payable !== Number(row.payable) || preview.cost !== Number(row.cost);
    });
    expect(mismatches.slice(0, 5)).toEqual([]);
    // Invariants on what is stored: bruto − retención = líquido; neto + IVA = total (by construction, never off).
    for (const row of rows) expect(Number(row.payable) > 0 && Number(row.cost) > 0).toBe(true);
  });
});

describe("QA técnicos: ciclo de vida del cargo", () => {
  it("4. one charge of each backing, and one corrected sin respaldo -> factura -> boleta", async () => {
    const [job] = [ids.jobs[5]];
    const none = await charge(ids.techs.T1, job, "none", "amount", 50000, "2026-01-10");
    expect(none).toMatchObject({ amount: 50000, net_amount: 50000, backing: "none", document_status: "no_aplica" });
    const fac = await charge(ids.techs.T1, job, "factura", "net", 100000, "2026-01-10");
    expect(fac).toMatchObject({ amount: 119000, net_amount: 100000, document_status: "pendiente" });
    const bol = await charge(ids.techs.T1, job, "boleta", "liquid", 375000, "2026-01-10");
    expect(bol).toMatchObject({ amount: 375000, net_amount: 442478, document_status: "pendiente" });

    const own = async (charge: Charge) =>
      ok<{ net_amount: number; tax_amount: number; total_amount: number }>(
        member.from("cost_documents").select("net_amount, tax_amount, total_amount").eq("id", charge.cost_document_id!).single(),
      );
    const update = (backing: Backing, enteredAs: EnteredAs, value: number) =>
      ok<Charge>(
        member
          .rpc("update_backed_technician_charge", {
            p_charge_id: none.id,
            p_description: null,
            p_charge_date: "2026-01-10",
            p_backing: backing,
            p_entered_as: enteredAs,
            p_value: value,
          })
          .single(),
      );

    const toFactura = await update("factura", "total", 119000);
    expect(toFactura).toMatchObject({ backing: "factura", amount: 119000, net_amount: 100000, document_status: "pendiente", withholding_rate: null });
    expect(await own(toFactura)).toEqual({ net_amount: 100000, tax_amount: 19000, total_amount: 119000 });

    const toBoleta = await update("boleta", "gross", 442478);
    expect(toBoleta).toMatchObject({ backing: "boleta", amount: 375000, net_amount: 442478, document_status: "pendiente", withholding_rate: 0.1525 });
    expect(await own(toBoleta)).toEqual({ net_amount: 442478, tax_amount: 0, total_amount: 442478 });

    const back = await update("none", "amount", 50000);
    expect(back).toMatchObject({ backing: "none", amount: 50000, net_amount: 50000, document_status: "no_aplica", withholding_rate: null });
    expect(await own(back)).toEqual({ net_amount: 50000, tax_amount: 0, total_amount: 50000 });
  });

  it("5. a charge with a payment, or linked, cannot change its amounts nor be deleted, with a clear message", async () => {
    const paid = await charge(ids.techs.T1, ids.jobs[5], "factura", "net", 10000, "2026-01-11");
    await ok(
      member.rpc("record_technician_payment", {
        p_personnel_id: ids.techs.T1,
        p_payment_date: "2026-01-12",
        p_amount: 5000,
        p_method: null,
        p_notes: null,
        p_applications: [{ charge_id: paid.id, amount: 5000 }],
      }),
    );
    const edit = {
      p_charge_id: paid.id,
      p_description: null,
      p_charge_date: "2026-01-11",
      p_backing: "factura",
      p_entered_as: "net",
      p_value: 20000,
    };
    expect(await fails(member.rpc("update_backed_technician_charge", edit))).toMatch(/already has payments applied/);
    expect(await fails(member.rpc("delete_technician_charge", { p_charge_id: paid.id }))).toMatch(/already has payments applied/);

    // Linked (a paid charge can be linked).
    const document = await importDocument(ids.suppliers.T1, factura("1101", 10000, "2026-01-20"));
    await ok(link(document, [paid.id]));
    expect((await chargeRow(paid.id)).document_status).toBe("recibida");
    await ok(member.from("technician_payments").delete().eq("personnel_id", ids.techs.T1).select("id"));
    expect(await fails(member.rpc("update_backed_technician_charge", edit))).toMatch(
      /vinculado a un documento: desvinculalo antes de cambiar el monto o el respaldo/,
    );
    expect(await fails(member.rpc("delete_technician_charge", { p_charge_id: paid.id }))).toMatch(
      /vinculado a un documento: desvinculalo antes de eliminarlo/,
    );
  });

  it("6. one payment covering charges of the three backings leaves the right saldo", async () => {
    const none = await charge(ids.techs.T3, ids.jobs[5], "none", "amount", 50000, "2026-01-13");
    const fac = await charge(ids.techs.T3, ids.jobs[5], "factura", "net", 100000, "2026-01-13");
    const bol = await charge(ids.techs.T3, ids.jobs[5], "boleta", "liquid", 375000, "2026-01-13");
    // 50.000 + 119.000 + 375.000 = 544.000 owed; pay 500.000 (all but 44.000 of the boleta).
    await ok(
      member.rpc("record_technician_payment", {
        p_personnel_id: ids.techs.T3,
        p_payment_date: "2026-01-14",
        p_amount: 500000,
        p_method: "transferencia",
        p_notes: null,
        p_applications: [
          { charge_id: none.id, amount: 50000 },
          { charge_id: fac.id, amount: 119000 },
          { charge_id: bol.id, amount: 331000 },
        ],
      }),
    );
    const { charges } = await getTechnicianAccount(ids.cl, ids.techs.T3);
    const summary = summarizeByTechnician(charges).get(ids.techs.T3)!;
    expect(summary).toMatchObject({ charged: 544000, paid: 500000, balance: 44000, pendingDocuments: 2 });
    expect(charges.find((row) => row.id === bol.id)?.outstanding).toBe(44000);
    // A boleta cannot be paid above its líquido (the retención is not owed to the technician).
    expect(
      await fails(
        member.rpc("record_technician_payment", {
          p_personnel_id: ids.techs.T3,
          p_payment_date: "2026-01-15",
          p_amount: 44001,
          p_method: null,
          p_notes: null,
          p_applications: [{ charge_id: bol.id, amount: 44001 }],
        }),
      ),
    ).toMatch(/cannot exceed its amount/);
  });
});

describe("QA técnicos: vínculo", () => {
  it("7. a factura covering 3 charges of 3 jobs: costs, margins, month, clients and areas as before the factura", async () => {
    const period = "2026-03-01";
    const charges = await Promise.all(
      [0, 1, 2].map((job) => charge(ids.techs.T1, ids.jobs[job], "factura", "net", 100000, "2026-03-05")),
    );
    // A sale on J1, so it has a margin to keep.
    await ok(
      db
        .from("sales_documents")
        .insert({
          company_id: ids.cl,
          client_id: ids.clients[0],
          project_id: ids.jobs[0],
          business_area_id: ids.areas[0],
          document_type: "invoice",
          document_number: `${tag}-V1`,
          document_date: "2026-03-10",
          currency: "CLP",
          net_amount: 250000,
          tax_amount: 47500,
          total_amount: 297500,
        })
        .select("id"),
    );
    const beforeMonth = await month(period);
    const before = await breakdown(period);
    expect(before.projects[ids.jobs[0]]).toEqual({ costs: 100000, margin: 150000 });
    expect(before.clients[ids.clients[0]].costs).toBe(200000);
    expect(before.areas[ids.areas[0]].costs).toBe(200000);

    const document = await importDocument(ids.suppliers.T1, factura("3001", 300000, "2026-03-20"));
    const imported = await month(period);
    expect(imported.directCosts + imported.generalCosts).toBe(beforeMonth.directCosts + beforeMonth.generalCosts + 300000);

    await ok(link(document, charges.map((row) => row.id)));
    const afterMonth = await month(period);
    const after = await breakdown(period);
    expect(afterMonth.directCosts + afterMonth.generalCosts).toBe(beforeMonth.directCosts + beforeMonth.generalCosts);
    expect(afterMonth.operatingResult).toBe(beforeMonth.operatingResult);
    expect(afterMonth.netSales).toBe(beforeMonth.netSales);
    // Several jobs: the factura is split by amounts (like "Dividir"), so the month shows it as a general cost.
    expect(afterMonth.directCosts).toBe(beforeMonth.directCosts - 300000);
    expect(afterMonth.generalCosts).toBe(beforeMonth.generalCosts + 300000);
    for (const id of ids.jobs) {
      expect(after.projects[id].costs).toBeCloseTo(before.projects[id].costs, 6);
      expect(after.projects[id].margin).toBeCloseTo(before.projects[id].margin, 6);
    }
    for (const id of ids.clients) expect(after.clients[id].costs).toBeCloseTo(before.clients[id].costs, 6);
    for (const id of ids.areas) expect(after.areas[id].costs).toBeCloseTo(before.areas[id].costs, 6);
    for (const row of charges) expect((await chargeRow(row.id)).document_status).toBe("recibida");
  });

  it("8. a boleta covering 2 charges of the same job: a direct cost of that job", async () => {
    const period = "2026-04-01";
    const a = await charge(ids.techs.T1, ids.jobs[3], "boleta", "gross", 200000, "2026-04-02");
    const b = await charge(ids.techs.T1, ids.jobs[3], "boleta", "gross", 300000, "2026-04-03");
    const before = await month(period);
    const document = await importDocument(ids.suppliers.T1, boleta("4001", 500000, 423750, "2026-04-20"));
    const result = await ok<{ projects: number }>(link(document, [a.id, b.id]));
    expect(result.projects).toBe(1);
    const stored = await ok<{ classification: string; project_id: string }>(
      member.from("cost_documents").select("classification, project_id").eq("id", document).single(),
    );
    expect(stored).toEqual({ classification: "direct", project_id: ids.jobs[3] });
    const after = await month(period);
    expect(after.directCosts).toBe(before.directCosts);
    expect(after.generalCosts).toBe(before.generalCosts);
    expect((await breakdown(period)).projects[ids.jobs[3]].costs).toBe(500000);
  });

  it("9. charge in May, document in June: before linking it counts in May (and June once imported), after linking only in June", async () => {
    const c = await charge(ids.techs.T1, ids.jobs[4], "factura", "net", 100000, "2026-05-15");
    const may = async () => {
      const m = await month("2026-05-01");
      return m.directCosts + m.generalCosts;
    };
    const june = async () => {
      const m = await month("2026-06-01");
      return m.directCosts + m.generalCosts;
    };
    expect([await may(), await june()]).toEqual([100000, 0]);
    const document = await importDocument(ids.suppliers.T1, factura("6001", 100000, "2026-06-10"));
    expect([await may(), await june()]).toEqual([100000, 100000]);
    await ok(link(document, [c.id]));
    expect([await may(), await june()]).toEqual([0, 100000]);
    // The job's accumulated cost does not change.
    const accumulated = (await getProfitabilityBreakdown(ids.cl, "2026-06-01")).projects.find((row) => row.id === ids.jobs[4]);
    expect(accumulated?.accumulatedCosts).toBe(100000);
  });

  it("10. a document assigned by hand or split is replaced; one allocated to services is refused (never duplicated)", async () => {
    const period = "2026-07-01";
    // Split between J1 and J2, then linked to a charge of J3.
    const c = await charge(ids.techs.T1, ids.jobs[2], "factura", "net", 100000, "2026-07-02");
    const split = await importDocument(ids.suppliers.T1, factura("7001", 100000, "2026-07-10"));
    await ok(
      member.rpc("set_cost_allocations", {
        p_cost_document_id: split,
        p_allocations: [
          { target_type: "project", target_id: ids.jobs[0], method: "fixed_amount", value: 59500 },
          { target_type: "project", target_id: ids.jobs[1], method: "fixed_amount", value: 59500 },
        ],
      }),
    );
    const beforeLink = await breakdown(period);
    expect(beforeLink.projects[ids.jobs[0]].costs).toBe(50000);
    expect(await fails(link(split, [c.id]))).toMatch(/^ALLOCATED: /);
    await ok(link(split, [c.id], true));
    const afterLink = await breakdown(period);
    expect(afterLink.projects[ids.jobs[0]].costs).toBe(0);
    expect(afterLink.projects[ids.jobs[1]].costs).toBe(0);
    expect(afterLink.projects[ids.jobs[2]].costs).toBe(100000);

    // Allocated to the recurring service's July period: refused, even when asked to replace.
    const d = await charge(ids.techs.T1, ids.jobs[3], "factura", "net", 80000, "2026-07-03");
    const services = await importDocument(ids.suppliers.T1, factura("7002", 80000, "2026-07-11"));
    await ok(
      member.rpc("set_cost_service_allocations", {
        p_cost_document_id: services,
        p_allocations: [{ cost_period_id: ids.servicePeriod, amount: 80000, status: "confirmed" }],
      }),
    );
    const monthBefore = await month(period);
    expect(await fails(link(services, [d.id], true))).toMatch(/^SERVICES: /);
    expect(await fails(link(services, [d.id], false))).toMatch(/^SERVICES: /);
    expect((await chargeRow(d.id)).cost_document_id).not.toBeNull();
    const monthAfter = await month(period);
    expect(monthAfter.directCosts + monthAfter.generalCosts).toBe(monthBefore.directCosts + monthBefore.generalCosts);
    // Nor suggested.
    expect((await suggestTechnicianDocuments(member, ids.cl, { documentIds: [services] })).created).toBe(0);
    // Mixed (services + split) is refused too.
    const mixed = await importDocument(ids.suppliers.T1, factura("7003", 80000, "2026-07-12"));
    // A period takes one row per document, so a second document can share it.
    await ok(
      member.rpc("set_cost_document_allocations", {
        p_cost_document_id: mixed,
        p_allocations: [{ target_type: "project", target_id: ids.jobs[0], method: "fixed_amount", value: 47600, position: 1 }],
        p_service_allocations: [{ cost_period_id: ids.servicePeriod, gross_amount: 47600, position: 0 }],
      }),
    );
    expect(await fails(link(mixed, [d.id], true))).toMatch(/^SERVICES: /);
  });

  it("11. unlink, then link the same document to other charges", async () => {
    const a1 = await charge(ids.techs.T1, ids.jobs[0], "factura", "net", 50000, "2026-08-02");
    const a2 = await charge(ids.techs.T1, ids.jobs[1], "factura", "net", 50000, "2026-08-02");
    const b1 = await charge(ids.techs.T1, ids.jobs[2], "factura", "net", 100000, "2026-08-03");
    const document = await importDocument(ids.suppliers.T1, factura("8001", 100000, "2026-08-20"));
    await ok(link(document, [a1.id, a2.id]));
    await ok(member.rpc("unlink_technician_document", { p_cost_document_id: document }));
    for (const id of [a1.id, a2.id]) {
      const row = await chargeRow(id);
      expect(row.document_status).toBe("pendiente");
      expect(row.cost_document_id).not.toBeNull();
    }
    await ok(link(document, [b1.id]));
    const projects = (await breakdown("2026-08-01")).projects;
    expect([projects[ids.jobs[0]].costs, projects[ids.jobs[1]].costs, projects[ids.jobs[2]].costs]).toEqual([50000, 50000, 100000]);
    const m = await month("2026-08-01");
    expect(m.directCosts + m.generalCosts).toBe(200000);
  });

  it("12. deleting a linked document gives the charges their own cost back, pending", async () => {
    const c = await charge(ids.techs.T1, ids.jobs[0], "boleta", "gross", 300000, "2026-09-02");
    const document = await importDocument(ids.suppliers.T1, boleta("9101", 300000, 254250, "2026-09-10"));
    await ok(link(document, [c.id]));
    const result = await ok<{ unlinked_charges: number }>(member.rpc("delete_cost_document", { p_cost_document_id: document }));
    expect(result.unlinked_charges).toBe(1);
    const row = await chargeRow(c.id);
    expect(row.document_status).toBe("pendiente");
    const own = await ok<{ net_amount: number; total_amount: number }>(
      member.from("cost_documents").select("net_amount, total_amount").eq("id", row.cost_document_id!).single(),
    );
    expect(own).toEqual({ net_amount: 300000, total_amount: 300000 });
    expect((await breakdown("2026-09-01")).projects[ids.jobs[0]].costs).toBe(300000);
  });

  it("13. 1 peso off per charge links; 2 pesos off per charge does not, and says the difference", async () => {
    const near = await Promise.all([0, 1, 2].map((job) => charge(ids.techs.T1, ids.jobs[job], "factura", "net", 100001, "2026-02-03")));
    const document = await importDocument(ids.suppliers.T1, factura("2001", 300000, "2026-02-20"));
    await ok(link(document, near.map((row) => row.id)));
    const m = await month("2026-02-01");
    expect(m.directCosts + m.generalCosts).toBe(300000); // the document's net: the 3 pesos of rounding are gone
    for (const job of [0, 1, 2]) expect((await breakdown("2026-02-01")).projects[ids.jobs[job]].costs).toBeCloseTo(100000, 0);

    const far = await Promise.all([3, 4, 5].map((job) => charge(ids.techs.T1, ids.jobs[job], "factura", "net", 100002, "2026-02-04")));
    const other = await importDocument(ids.suppliers.T1, factura("2002", 300000, "2026-02-21"));
    const message = await fails(link(other, far.map((row) => row.id)));
    expect(message).toMatch(/^AMOUNT_MISMATCH: Los costos de los cargos suman 300006 y el neto del documento es 300000: diferencia -6$/);
  });

  it("14. invalid links fail: another technician, another backing, a credit note, a linked charge, another company, no membership", async () => {
    const t1 = await charge(ids.techs.T1, ids.jobs[0], "factura", "net", 70000, "2026-12-01");
    const t1Boleta = await charge(ids.techs.T1, ids.jobs[0], "boleta", "gross", 70000, "2026-12-01");
    const ofT2 = await importDocument(ids.suppliers.T2, factura("1201", 70000, "2026-12-10"));
    expect(await fails(link(ofT2, [t1.id]))).toMatch(/^CHARGES: Todos los cargos tienen que ser del técnico del documento/);

    const facturaT1 = await importDocument(ids.suppliers.T1, factura("1202", 70000, "2026-12-10"));
    expect(await fails(link(facturaT1, [t1Boleta.id]))).toMatch(/^CHARGES: .*otro respaldo \(boleta\): el documento es una factura/);

    const [credit] = await importRows(ids.suppliers.T1, [{ type: "N/C-EL", number: "55", net: 70000, tax: 13300, date: "2026-12-11" }]);
    expect(await fails(link(credit.cost_document_id!, [t1.id]))).toMatch(/^NOT_ELIGIBLE: /);

    await ok(link(facturaT1, [t1.id]));
    const again = await importDocument(ids.suppliers.T1, factura("1203", 70000, "2026-12-12"));
    expect(await fails(link(again, [t1.id]))).toMatch(/^CHARGES: .*ya está vinculado a otro documento/);

    const foreign = await ok<Charge>(
      member
        .rpc("create_backed_technician_charge", {
          p_project_id: ids.otherJob,
          p_personnel_id: ids.otherTech,
          p_description: null,
          p_charge_date: "2026-12-01",
          p_backing: "factura",
          p_entered_as: "net",
          p_value: 70000,
        })
        .single(),
    );
    expect(await fails(link(again, [foreign.id]))).toMatch(/^CHARGES: Todos los cargos tienen que ser del técnico del documento/);

    // Without membership: nothing is found, nothing is written.
    const free = await charge(ids.techs.T1, ids.jobs[1], "factura", "net", 70000, "2026-12-02");
    expect(await fails(outsider.rpc("link_technician_document", { p_cost_document_id: again, p_charge_ids: [free.id], p_replace_allocations: true }))).toMatch(
      /Documento no encontrado/,
    );
    expect(await fails(outsider.rpc("unlink_technician_document", { p_cost_document_id: facturaT1 }))).toMatch(/Documento no encontrado/);
    expect(
      await fails(
        outsider.rpc("update_backed_technician_charge", {
          p_charge_id: free.id,
          p_description: null,
          p_charge_date: "2026-12-02",
          p_backing: "none",
          p_entered_as: "amount",
          p_value: 1,
        }),
      ),
    ).toMatch(/Technician charge not found/);
    expect(await fails(outsider.rpc("link_technician_tax_id", { p_personnel_id: ids.techs.T1, p_tax_id: "1-9", p_supplier_name: null }))).toMatch(
      /Technician not found/,
    );
    expect(await ok<unknown[]>(outsider.from("technician_charge_documents").select("id").eq("company_id", ids.cl))).toEqual([]);
    expect(await ok<unknown[]>(outsider.from("technician_charges").select("id").eq("company_id", ids.cl))).toEqual([]);
    // And a member cannot write a link by hand, skipping the RPC.
    expect(
      await fails(
        member.from("technician_charge_documents").insert({ company_id: ids.cl, charge_id: free.id, cost_document_id: again, cost_amount: 70000 }),
      ),
    ).toMatch(/link_technician_document/);
    expect((await chargeRow(free.id)).cost_document_id).not.toBeNull();
  });

  it("15. a credit note of a technician's supplier is never suggested nor linked, and still subtracts", async () => {
    const period = "2026-10-01";
    const before = await month(period);
    const [credit] = await importRows(ids.suppliers.T2, [{ type: "N/C-EL", number: "77", net: 40000, tax: 7600, date: "2026-10-05" }]);
    await charge(ids.techs.T2, ids.jobs[0], "factura", "net", 40000, "2026-10-01");
    expect((await suggestTechnicianDocuments(member, ids.cl, { documentIds: [credit.cost_document_id!] })).created).toBe(0);
    const after = await month(period);
    expect(after.directCosts + after.generalCosts).toBe(before.directCosts + before.generalCosts + 40000 - 40000);
    const stored = await ok<{ net_amount: number; document_type: string }>(
      member.from("cost_documents").select("net_amount, document_type").eq("id", credit.cost_document_id!).single(),
    );
    expect(stored).toEqual({ net_amount: -40000, document_type: "credit_note" });
  });
});

describe("QA técnicos: RUT y sugerencias", () => {
  it("16. a RUT with or without dots and hyphen, and k lower case, finds the same supplier; another technician's is refused", async () => {
    const tech = await technician("R1", "12.345.678-k");
    for (const variant of ["12345678-K", "12345678k", "12.345.678 - k", " 12.345.678-K "]) {
      await ok(member.rpc("link_technician_tax_id", { p_personnel_id: tech, p_tax_id: variant, p_supplier_name: null }));
    }
    const suppliers = await ok<{ id: string }[]>(member.from("suppliers").select("id").eq("company_id", ids.cl).ilike("tax_id", "%12%345%678%"));
    expect(suppliers).toHaveLength(1);
    expect(await fails(member.rpc("link_technician_tax_id", { p_personnel_id: ids.techs.T2, p_tax_id: "12345678K", p_supplier_name: null }))).toMatch(
      /ya está vinculado al técnico/,
    );

    // Removing a RUT: refused while one of its documents is linked; allowed otherwise.
    const c = await charge(tech, ids.jobs[0], "factura", "net", 10000, "2026-11-01");
    const document = await importDocument(ids.suppliers.R1, factura("1601", 10000, "2026-11-02"));
    await ok(link(document, [c.id]));
    const linkRow = await ok<{ id: string }>(member.from("technician_suppliers").select("id").eq("supplier_id", ids.suppliers.R1).single());
    expect(await fails(member.from("technician_suppliers").delete().eq("id", linkRow.id))).toMatch(/desvinculalos antes de quitar el RUT/);
    await ok(member.rpc("unlink_technician_document", { p_cost_document_id: document }));
    await ok(member.from("technician_suppliers").delete().eq("id", linkRow.id).select("id"));
  });

  it("17-18. suggestions: unique combination, two combinations, more than 15, discarded, the same CSV twice", async () => {
    // Unique combination (boleta bruto 400.000 = 150.000 + 250.000).
    const u = await technician("S1", "20.000.001-5", "boleta");
    const u1 = await charge(u, ids.jobs[0], "boleta", "gross", 150000, "2025-11-01");
    const u2 = await charge(u, ids.jobs[1], "boleta", "gross", 250000, "2025-11-02");
    await charge(u, ids.jobs[2], "boleta", "gross", 90000, "2025-11-03");
    const rows = [boleta("1701", 400000, 342000, "2025-11-20")];
    const first = await importRows(ids.suppliers.S1, rows);
    expect(first.map((row) => row.status)).toEqual(["imported"]);
    expect(await suggestTechnicianDocuments(member, ids.cl, { documentIds: [first[0].cost_document_id!] })).toEqual({ created: 1, error: null });
    const suggestion = await ok<{ charge_ids: string[] }>(
      member.from("technician_document_suggestions").select("charge_ids").eq("cost_document_id", first[0].cost_document_id!).single(),
    );
    expect(new Set(suggestion.charge_ids)).toEqual(new Set([u1.id, u2.id]));
    // 17. The same CSV again: a duplicate, no new document, no new suggestion.
    const second = await importRows(ids.suppliers.S1, rows);
    expect(second.map((row) => row.status)).toEqual(["duplicate"]);
    expect(await suggestTechnicianDocuments(member, ids.cl, { personnelId: u })).toEqual({ created: 0, error: null });
    expect(await ok<unknown[]>(member.from("technician_document_suggestions").select("id").eq("personnel_id", u))).toHaveLength(1);

    // Two combinations: nothing.
    const t = await technician("S2", "20.000.002-3", "factura");
    await charge(t, ids.jobs[0], "factura", "net", 70000, "2025-11-01");
    await charge(t, ids.jobs[1], "factura", "net", 70000, "2025-11-01");
    const two = await importDocument(ids.suppliers.S2, factura("1702", 70000, "2025-11-20"));
    expect((await suggestTechnicianDocuments(member, ids.cl, { documentIds: [two] })).created).toBe(0);

    // More than 15 candidates: nothing, even with one exact charge.
    const m = await technician("S3", "20.000.003-1", "factura");
    await charge(m, ids.jobs[0], "factura", "net", 100000, "2025-11-01");
    for (let index = 0; index < 15; index++) await charge(m, ids.jobs[1], "factura", "net", 3, "2025-11-01");
    const many = await importDocument(ids.suppliers.S3, factura("1703", 100000, "2025-11-20"));
    expect((await suggestTechnicianDocuments(member, ids.cl, { documentIds: [many] })).created).toBe(0);

    // Discarded: not proposed again.
    await ok(member.from("technician_document_suggestions").update({ status: "dismissed" }).eq("personnel_id", u).select("id"));
    expect((await suggestTechnicianDocuments(member, ids.cl, { personnelId: u })).created).toBe(0);
    expect(await ok<{ status: string }[]>(member.from("technician_document_suggestions").select("status").eq("personnel_id", u))).toEqual([
      { status: "dismissed" },
    ]);
  });

  it("18. Confirmar todas with a suggestion that is no longer valid links the rest and says so", async () => {
    const tech = await technician("S4", "20.000.004-K", "factura");
    const good = await charge(tech, ids.jobs[0], "factura", "net", 30000, "2025-12-01");
    const moved = await charge(tech, ids.jobs[1], "factura", "net", 45000, "2025-12-01");
    const goodDoc = await importDocument(ids.suppliers.S4, factura("1801", 30000, "2025-12-10"));
    const movedDoc = await importDocument(ids.suppliers.S4, factura("1802", 45000, "2025-12-11"));
    expect((await suggestTechnicianDocuments(member, ids.cl, { personnelId: tech })).created).toBe(2);
    // Meanwhile the second charge is corrected: its suggestion no longer adds up.
    // (A correction drops it; here a stale one is left on purpose, as after a race.)
    await ok(
      member.rpc("update_backed_technician_charge", {
        p_charge_id: moved.id,
        p_description: null,
        p_charge_date: "2025-12-01",
        p_backing: "factura",
        p_entered_as: "net",
        p_value: 40000,
      }),
    );
    await ok(
      member
        .from("technician_document_suggestions")
        .insert({ company_id: ids.cl, cost_document_id: movedDoc, personnel_id: tech, charge_ids: [moved.id] })
        .select("id"),
    );
    const result = await resolveTechnicianSuggestions(ids.cl, [goodDoc, movedDoc], "confirm", false);
    expect(result.count).toBe(1);
    expect(result.error).toMatch(/^1 sin vincular: Los costos de los cargos suman 40000 y el neto del documento es 45000/);
    expect((await chargeRow(good.id)).document_status).toBe("recibida");
    expect((await chargeRow(moved.id)).document_status).toBe("pendiente");
  });
});

describe("QA técnicos: pantallas y regresión", () => {
  it("19. a job whose only charge is sin respaldo and paid is ready as far as technicians go", async () => {
    const c = await charge(ids.techs.T3, ids.jobs[4], "none", "amount", 20000, "2026-11-05");
    await ok(
      member.rpc("record_technician_payment", {
        p_personnel_id: ids.techs.T3,
        p_payment_date: "2026-11-06",
        p_amount: 20000,
        p_method: null,
        p_notes: null,
        p_applications: [{ charge_id: c.id, amount: 20000 }],
      }),
    );
    const charges = (await getTechnicianCharges(ids.cl)).filter((row) => row.id === c.id);
    expect(summarizeByProject(charges).get(ids.jobs[4])).toMatchObject({ payment: "pagado", document: "no_aplica" });
  });

  it("20. the assistant (and MCP, the same tools) reads the saldo of each technician from what is owed", async () => {
    const outcome = await executeTool("get_technician_balances", {}, { companyId: ids.cl });
    const balances = outcome.result as { technician: string; outstanding: number }[];
    for (const key of ["T1", "T3"]) {
      const { charges } = await getTechnicianAccount(ids.cl, ids.techs[key]);
      const expected = summarizeByTechnician(charges).get(ids.techs[key])?.balance ?? 0;
      expect(balances.find((row) => row.technician === `${tag} Técnico ${key}`)?.outstanding ?? 0).toBeCloseTo(expected, 6);
    }
  });

  it("21. Uruguay: charge, payment and cuenta corriente as before; no backing, no RUT", async () => {
    const c = await ok<Charge>(
      member
        .rpc("create_technician_charge", {
          p_project_id: ids.uyJob,
          p_personnel_id: ids.uyTech,
          p_description: null,
          p_charge_date: "2026-10-05",
          p_amount: 12200,
          p_vat_included: true,
          p_vat_rate: 0.22,
        })
        .single(),
    );
    expect(c).toMatchObject({ backing: null, amount: 12200, net_amount: 10000, document_status: "pendiente" });
    await ok(
      member.rpc("record_technician_payment", {
        p_personnel_id: ids.uyTech,
        p_payment_date: "2026-10-06",
        p_amount: 2200,
        p_method: null,
        p_notes: null,
        p_applications: [{ charge_id: c.id, amount: 2200 }],
      }),
    );
    const { charges, payments } = await getTechnicianAccount(ids.uy, ids.uyTech);
    expect(summarizeByTechnician(charges).get(ids.uyTech)).toMatchObject({ charged: 12200, paid: 2200, balance: 10000, pendingDocuments: 1 });
    expect(payments).toHaveLength(1);
    expect(charges[0]).toMatchObject({ backing: null, linked_document: null });
    expect(await fails(member.rpc("link_technician_tax_id", { p_personnel_id: ids.uyTech, p_tax_id: "1-9", p_supplier_name: null }))).toMatch(
      /solo en empresas de Chile/,
    );
  });
});
