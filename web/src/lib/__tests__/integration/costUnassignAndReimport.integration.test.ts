/**
 * "Quitar del trabajo" and importing again (20261031010000), against the real
 * inma-erp-dev project, as a signed-in member (RLS on):
 *
 * 1. Taking a direct cost off a job leaves the document intact, general and
 *    unassigned, ready to be assigned again.
 * 2. Taking a split cost off one job only removes that job's allocation.
 * 3. A technician's own cost document cannot be taken off.
 * 4. A document deleted on purpose is no duplicate: importing it creates it
 *    again. A document that exists still is, unless forced.
 *
 * Run with `npm run test:integration`.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { anonClient, assertDevProject, serviceClient } from "./devProject";

const tag = `TEST_UNASSIGN ${randomUUID().slice(0, 6)}`;
const db = serviceClient();
const ids = { company: "", user: "", supplier: "", projectA: "", projectB: "", technician: "" };
let member: SupabaseClient;

async function ok<T = unknown>(p: PromiseLike<{ data: unknown; error: unknown }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(JSON.stringify(error));
  return data as T;
}

async function importRow(number: string, force = false) {
  const batch = await ok<{ id: string }>(
    member.rpc("create_cost_import_batch", { p_company_id: ids.company, p_file_name: `${tag}.csv`, p_total_rows: 1 }),
  );
  const [row] = await ok<{ status: string; error_message: string | null; cost_document_id: string | null }[]>(
    member.rpc("import_cost_rows_batch", {
      p_import_batch_id: batch.id,
      p_rows: [
        {
          row_number: 1,
          raw_data: { "Nº documento": number },
          supplier_id: ids.supplier,
          document_date: "2026-08-14",
          currency: "CLP",
          amount: 100000,
          tax_amount: 19000,
          document_type: "invoice",
          source_document_type: "FAC-EL",
          document_number: number,
          force,
        },
      ],
    }),
  );
  return row;
}

const readDocument = (id: string) =>
  ok<{ classification: string; project_id: string | null; total_amount: number; cost_lines: unknown[] } | null>(
    member.from("cost_documents").select("classification, project_id, total_amount, cost_lines(id)").eq("id", id).maybeSingle(),
  );

beforeAll(async () => {
  assertDevProject();
  const company = await ok<{ id: string }>(
    db.from("companies").insert({ name: tag, country: "CL", currency: "CLP" }).select("id").single(),
  );
  ids.company = company.id;
  const email = `test_unassign_${randomUUID().slice(0, 6)}@example.test`;
  const password = randomBytes(24).toString("base64url");
  const { data: user, error } = await db.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  ids.user = user.user.id;
  await ok(db.from("company_memberships").insert({ user_id: ids.user, company_id: ids.company, role: "admin" }).select("id"));
  member = anonClient();
  const { error: signInError } = await member.auth.signInWithPassword({ email, password });
  if (signInError) throw signInError;

  const supplier = await ok<{ id: string }>(
    member.from("suppliers").insert({ company_id: ids.company, name: `${tag} Proveedor` }).select("id").single(),
  );
  ids.supplier = supplier.id;
  const client = await ok<{ id: string }>(member.from("clients").insert({ company_id: ids.company, name: tag }).select("id").single());
  const area = await ok<{ id: string }>(
    db.from("business_areas").select("id").eq("company_id", ids.company).limit(1).single(),
  );
  for (const key of ["projectA", "projectB"] as const) {
    const project = await ok<{ id: string }>(
      member
        .from("projects")
        .insert({ company_id: ids.company, client_id: client.id, business_area_id: area.id, name: `${tag} ${key}`, status: "en_ejecucion" })
        .select("id")
        .single(),
    );
    ids[key] = project.id;
  }
  const technician = await ok<{ id: string }>(
    member.from("personnel").insert({ company_id: ids.company, name: `${tag} Técnico`, type: "contractor" }).select("id").single(),
  );
  ids.technician = technician.id;
}, 120_000);

afterAll(async () => {
  const failures: unknown[] = [];
  const step = async (p: PromiseLike<{ error: unknown }>) => {
    const { error } = await p;
    if (error) failures.push(error);
  };
  if (ids.company) {
    const costDocs = ((await db.from("cost_documents").select("id").eq("company_id", ids.company)).data ?? []).map((r) => r.id);
    const batches = ((await db.from("cost_import_batches").select("id").eq("company_id", ids.company)).data ?? []).map((r) => r.id);
    await step(db.from("technician_charges").delete().eq("company_id", ids.company));
    if (costDocs.length) {
      await step(db.from("cost_documents").update({ import_row_id: null, duplicate_of_cost_document_id: null }).in("id", costDocs));
      await step(db.from("cost_allocations").delete().in("cost_document_id", costDocs));
      await step(db.from("cost_lines").delete().in("cost_document_id", costDocs));
    }
    if (batches.length) await step(db.from("cost_import_rows").delete().in("import_batch_id", batches));
    await step(db.from("cost_documents").delete().eq("company_id", ids.company));
    await step(db.from("cost_import_batches").delete().eq("company_id", ids.company));
    await step(db.from("personnel").delete().eq("company_id", ids.company));
    await step(db.from("projects").delete().eq("company_id", ids.company));
    await step(db.from("clients").delete().eq("company_id", ids.company));
    await step(db.from("suppliers").delete().eq("company_id", ids.company));
    await step(db.from("company_memberships").delete().eq("company_id", ids.company));
    await step(db.from("business_areas").delete().eq("company_id", ids.company));
    await step(db.from("companies").delete().eq("id", ids.company));
  }
  if (ids.user) {
    const { error } = await db.auth.admin.deleteUser(ids.user);
    if (error) failures.push(error);
  }
  if (failures.length) throw new Error(`cleanup failed (${tag}): ${JSON.stringify(failures)}`);
}, 120_000);

describe("unassign_cost_document_from_project", () => {
  it("takes a direct cost off the job and leaves the document intact, ready to assign again", async () => {
    const { cost_document_id: id } = await importRow("1001");
    await ok(member.rpc("assign_cost_document_to_project", { p_cost_document_id: id, p_project_id: ids.projectA }));

    const result = await ok<{ was_direct: boolean }>(
      member.rpc("unassign_cost_document_from_project", { p_cost_document_id: id, p_project_id: ids.projectA }),
    );
    expect(result.was_direct).toBe(true);

    const document = await readDocument(id as string);
    expect(document).toMatchObject({ classification: "general", project_id: null, total_amount: 119000 });
    expect(document?.cost_lines).toHaveLength(1);

    await ok(member.rpc("assign_cost_document_to_project", { p_cost_document_id: id, p_project_id: ids.projectB }));
    expect(await readDocument(id as string)).toMatchObject({ classification: "direct", project_id: ids.projectB });
  });

  it("takes only that job's part of a split cost", async () => {
    const { cost_document_id: id } = await importRow("1002");
    await ok(
      member.rpc("set_cost_document_allocations", {
        p_cost_document_id: id,
        p_allocations: [
          { target_type: "project", target_id: ids.projectA, method: "percentage", value: 40, position: 0 },
          { target_type: "project", target_id: ids.projectB, method: "percentage", value: 60, position: 1 },
        ],
        p_service_allocations: [],
      }),
    );

    const result = await ok<{ was_direct: boolean; remaining_allocations: number }>(
      member.rpc("unassign_cost_document_from_project", { p_cost_document_id: id, p_project_id: ids.projectA }),
    );
    expect(result).toMatchObject({ was_direct: false, remaining_allocations: 1 });

    const rows = await ok<{ project_id: string }[]>(
      member.from("cost_allocations").select("project_id").eq("cost_document_id", id as string),
    );
    expect(rows.map((row) => row.project_id)).toEqual([ids.projectB]);
    expect(await readDocument(id as string)).toMatchObject({ classification: "general", total_amount: 119000 });
  });

  it("refuses a document that is not on that job", async () => {
    const { cost_document_id: id } = await importRow("1003");
    const { error } = await member.rpc("unassign_cost_document_from_project", {
      p_cost_document_id: id,
      p_project_id: ids.projectA,
    });
    expect(error?.message).toMatch(/no está asignado a este trabajo/);
  });

  it("refuses a technician's own cost document, which belongs to the charge", async () => {
    const charge = await ok<{ cost_document_id: string }>(
      member.rpc("create_technician_charge", {
        p_project_id: ids.projectA,
        p_personnel_id: ids.technician,
        p_description: tag,
        p_charge_date: "2026-08-14",
        p_amount: 50000,
        p_vat_included: false,
        p_vat_rate: 0,
      }),
    );
    const { error } = await member.rpc("unassign_cost_document_from_project", {
      p_cost_document_id: charge.cost_document_id,
      p_project_id: ids.projectA,
    });
    expect(error?.message).toMatch(/cargo de un técnico/);
  });
});

describe("import after deleting", () => {
  it("creates again a document deleted on purpose, keeping the import row as history", async () => {
    const first = await importRow("2001");
    expect(first.status).toBe("imported");
    await ok(member.rpc("delete_cost_document", { p_cost_document_id: first.cost_document_id }));

    const again = await importRow("2001");
    expect(again).toMatchObject({ status: "imported", error_message: null });
    expect(again.cost_document_id).not.toBe(first.cost_document_id);

    const history = await ok<{ deleted_document_number: string | null }[]>(
      db
        .from("cost_import_rows")
        .select("deleted_document_number, cost_import_batches!inner(company_id)")
        .eq("cost_import_batches.company_id", ids.company)
        .not("deleted_at", "is", null),
    );
    expect(history.map((row) => row.deleted_document_number)).toContain("2001");
  });

  it("still finds a document that exists as a duplicate, unless forced", async () => {
    const first = await importRow("2002");
    expect(first.status).toBe("imported");
    expect((await importRow("2002")).status).toBe("duplicate");
    expect((await importRow("2002", true)).status).toBe("imported");
  });
});
