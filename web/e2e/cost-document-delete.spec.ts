/**
 * Taking an expense off a job and deleting one, on throwaway companies in
 * inma-erp-dev (one Chilean, one Uruguayan): "Quitar del trabajo" on a
 * provisional expense leaves the document in Costos, unassigned; "Eliminar" on
 * a confirmed one with a receipt from its own page (the file leaves Storage);
 * on one assigned to a recurring service and on an imported one from Costos
 * (the import row keeps the record, and importing the same invoice again
 * creates it again); and a technician's charge, which is sent to Técnicos. The
 * job's Costos / Margen / Margen % follow each step. Run with
 * `npm run test:e2e` after `npm run build`.
 */
import { expect, test, type Page } from "@playwright/test";
import {
  admin,
  assertDev,
  createCompany,
  createMember,
  deleteCompanies,
  deleteUser,
  formatAmount,
  newTag,
  ok,
  signIn,
  type Member,
} from "./helpers/devSession";

const tag = newTag();
const ids = {
  cl: "",
  uy: "",
  project: "",
  uyProject: "",
  provisional: "",
  withReceipt: "",
  receiptPath: "",
  service: "",
  costPeriod: "",
  serviceDoc: "",
  imported: "",
  importBatch: "",
  technician: "",
  charge: "",
  chargeDoc: "",
  uyDoc: "",
};
const supplier = { serviceName: `${tag} Starlink`, importName: `${tag} Ferreteria`, importId: "", serviceId: "" };
let member: Member;

test.describe.configure({ mode: "serial" });

async function setupCompany(country: "CL" | "UY", currency: string) {
  const db = admin();
  const company = await createCompany(`${tag} ${country}`, country, currency);
  const client = await ok<{ id: string }>(db.from("clients").insert({ company_id: company, name: `${tag} cliente ${country}` }).select("id").single(), "client");
  const area = await ok<{ id: string }>(db.from("business_areas").insert({ company_id: company, name: `${tag} area ${country}` }).select("id").single(), "area");
  const project = await ok<{ id: string }>(
    db
      .from("projects")
      .insert({ company_id: company, client_id: client.id, business_area_id: area.id, name: `${tag} trabajo ${country}`, status: "en_ejecucion" })
      .select("id")
      .single(),
    "project",
  );
  return { company, client: client.id, project: project.id };
}

async function directCost(companyId: string, projectId: string, currency: string, description: string, amount: number) {
  const doc = await member.client
    .rpc("create_cost_document", {
      p_company_id: companyId,
      p_supplier_id: null,
      p_project_id: projectId,
      p_classification: "direct",
      p_document_date: "2026-10-05",
      p_currency: currency,
      p_tax_amount: 0,
      p_lines: [{ description, amount }],
    })
    .select()
    .single<{ id: string }>();
  if (doc.error || !doc.data) throw new Error(JSON.stringify(doc.error));
  return doc.data.id;
}

function importRows(force = false) {
  return [
    {
      row_number: 1,
      raw_data: { proveedor: supplier.importName, fecha: "08/10/2026", neto: "50000" },
      supplier_id: supplier.importId,
      document_date: "2026-10-08",
      currency: "CLP",
      amount: 50000,
      tax_amount: 9500,
      force,
      link_to_cost_document_id: null,
    },
  ];
}

async function importOnce(force = false) {
  const batch = await ok<{ id: string }>(
    member.client.rpc("create_cost_import_batch", { p_company_id: ids.cl, p_file_name: `${tag}.csv`, p_total_rows: 1 }),
    "batch",
  );
  ids.importBatch = batch.id;
  const rows = await ok<{ status: string; error_message: string | null; cost_document_id: string | null }[]>(
    member.client.rpc("import_cost_rows_batch", { p_import_batch_id: batch.id, p_rows: importRows(force) }),
    "import",
  );
  return rows[0];
}

/** The value of a summary card ("Costos", "Margen", "Margen %") of the job's page. */
function card(page: Page, label: string) {
  return page.locator("span.caps-label", { hasText: new RegExp(`^${label.replace("%", "\\%")}$`) }).locator("xpath=..");
}

async function deleteRow(page: Page, rowText: string, expectInDialog: string[]) {
  const row = page.getByRole("row").filter({ hasText: rowText }).filter({ has: page.getByRole("button", { name: "Eliminar" }) });
  await row.getByRole("button", { name: "Eliminar" }).click();
  const dialog = page.getByRole("dialog", { name: "Eliminar gasto" });
  for (const text of expectInDialog) await expect(dialog).toContainText(text);
  await dialog.getByRole("button", { name: "Sí, eliminar" }).click();
  await expect(page.getByRole("row").filter({ hasText: rowText })).toHaveCount(0);
}

async function unassignRow(page: Page, rowText: string, expectInDialog: string[]) {
  const row = page.getByRole("row").filter({ hasText: rowText }).filter({ has: page.getByRole("button", { name: "Quitar del trabajo" }) });
  await row.getByRole("button", { name: "Quitar del trabajo" }).click();
  const dialog = page.getByRole("dialog", { name: "Quitar gasto del trabajo" });
  for (const text of expectInDialog) await expect(dialog).toContainText(text);
  await dialog.getByRole("button", { name: "Sí, quitar" }).click();
  await expect(page.getByRole("row").filter({ hasText: rowText })).toHaveCount(0);
}

const count = async (table: string, column: string, value: string) =>
  (await admin().from(table).select("id", { count: "exact", head: true }).eq(column, value)).count;

test.beforeAll(async () => {
  assertDev();
  const cl = await setupCompany("CL", "CLP");
  const uy = await setupCompany("UY", "UYU");
  ids.cl = cl.company;
  ids.uy = uy.company;
  ids.project = cl.project;
  ids.uyProject = uy.project;
  member = await createMember(tag, [ids.cl, ids.uy]);
  const db = admin();

  // Revenue, so Margen % says something: 1.000.000 net.
  await ok(
    member.client.rpc("create_manual_sale_without_invoice", {
      p_company_id: ids.cl,
      p_project_id: ids.project,
      p_document_date: "2026-10-02",
      p_net_amount: 1_000_000,
      p_tax_amount: 0,
      p_description: `${tag} venta`,
    }),
    "manual sale",
  );

  // 1. Provisional, no receipt (the job's quick expense).
  const quick = await member.client
    .rpc("create_quick_cost_document", {
      p_company_id: ids.cl,
      p_project_id: ids.project,
      p_amount: 100_000,
      p_category: "materials",
      p_description: `${tag} cables provisorio`,
      p_document_date: "2026-10-06",
      p_currency: "CLP",
    })
    .select()
    .single<{ id: string }>();
  if (quick.error || !quick.data) throw new Error(JSON.stringify(quick.error));
  ids.provisional = quick.data.id;

  // 2. Confirmed, with a receipt in Storage.
  ids.withReceipt = await directCost(ids.cl, ids.project, "CLP", `${tag} equipos con boleta`, 200_000);
  ids.receiptPath = `${ids.cl}/${ids.withReceipt}/${tag}-boleta.txt`;
  await ok(member.client.storage.from("cost-receipts").upload(ids.receiptPath, new Blob(["boleta"], { type: "text/plain" })), "upload");
  await ok(member.client.from("cost_document_attachments").insert({ cost_document_id: ids.withReceipt, storage_path: ids.receiptPath }), "attachment");

  // 3. A technician's charge (its cost is Mano de obra of the job): 119.000 with VAT = 100.000 net.
  ids.technician = (await ok<{ id: string }>(member.client.from("personnel").insert({ company_id: ids.cl, name: `${tag} Tecnico`, type: "contractor" }).select("id").single(), "technician")).id;
  const charge = await ok<{ id: string; cost_document_id: string }>(
    member.client.rpc("create_technician_charge", {
      p_project_id: ids.project,
      p_personnel_id: ids.technician,
      p_description: `${tag} instalacion`,
      p_charge_date: "2026-10-07",
      p_amount: 119_000,
      p_vat_included: true,
      p_vat_rate: 0.19,
    }),
    "charge",
  );
  ids.charge = charge.id;
  ids.chargeDoc = charge.cost_document_id;

  // 4. A purchase invoice assigned to a recurring service's cost period.
  supplier.serviceId = (await ok<{ id: string }>(db.from("suppliers").insert({ company_id: ids.cl, name: supplier.serviceName }).select("id").single(), "supplier")).id;
  ids.service = (
    await ok<{ id: string }>(
      member.client
        .from("recurring_services")
        .insert({
          company_id: ids.cl,
          client_id: cl.client,
          name: `${tag} EBCO WIND`,
          currency: "CLP",
          reference_amount: 49990,
          periodicity: "monthly",
          invoicing_mode: "arrears",
          start_date: "2026-10-01",
          end_date: "2026-10-31",
          service_type: "starlink",
          fixed_cost: 31092,
          supplier_id: supplier.serviceId,
          status: "active",
          active: true,
        })
        .select("id")
        .single(),
      "service",
    )
  ).id;
  await ok(member.client.rpc("generate_recurring_service_occurrences_since_start", { p_service_id: ids.service, p_until: "2026-11-01" }), "cycles");
  const serviceDoc = await member.client
    .rpc("create_cost_document", {
      p_company_id: ids.cl,
      p_supplier_id: supplier.serviceId,
      p_project_id: null,
      p_classification: "general",
      p_document_date: "2026-10-20",
      p_currency: "CLP",
      p_tax_amount: 5907,
      p_lines: [{ description: `${tag} Starlink octubre`, amount: 31092 }],
    })
    .select()
    .single<{ id: string }>();
  if (serviceDoc.error || !serviceDoc.data) throw new Error(JSON.stringify(serviceDoc.error));
  ids.serviceDoc = serviceDoc.data.id;
  const [period] = await ok<{ id: string }[]>(
    member.client.from("recurring_service_cost_periods").select("id").eq("recurring_service_id", ids.service).eq("period", "2026-10-01"),
    "cost period",
  );
  ids.costPeriod = period.id;
  await ok(
    member.client.rpc("set_cost_service_allocations", { p_cost_document_id: ids.serviceDoc, p_allocations: [{ cost_period_id: period.id, amount: 31092 }] }),
    "service allocation",
  );

  // 5. An imported purchase invoice.
  supplier.importId = (await ok<{ id: string }>(db.from("suppliers").insert({ company_id: ids.cl, name: supplier.importName }).select("id").single(), "import supplier")).id;
  const imported = await importOnce();
  expect(imported.status).toBe("imported");
  ids.imported = imported.cost_document_id as string;

  // Uruguay: one direct cost.
  ids.uyDoc = await directCost(ids.uy, ids.uyProject, "UYU", `${tag} materiales UY`, 5_000);
});

test.afterAll(async () => {
  const db = admin();
  await db.storage.from("cost-receipts").remove([ids.receiptPath].filter(Boolean));
  await db.from("technician_charges").delete().in("company_id", [ids.cl, ids.uy].filter(Boolean));
  await db.from("personnel").delete().in("company_id", [ids.cl, ids.uy].filter(Boolean));
  await db.from("cost_service_allocations").delete().in("company_id", [ids.cl, ids.uy].filter(Boolean));
  await db.from("recurring_service_cost_periods").delete().eq("recurring_service_id", ids.service || "00000000-0000-0000-0000-000000000000");
  const failures = [...(await deleteCompanies([ids.cl, ids.uy].filter(Boolean))), ...(await deleteUser(member?.userId))];
  expect(failures).toEqual([]);
});

test("job page: takes a provisional expense off without deleting it, refuses a technician's charge, totals follow", async ({ page, context }) => {
  await signIn(context, member);
  await page.goto(`/companies/${ids.cl}/projects/${ids.project}`);
  // 100.000 provisional + 200.000 with receipt + 100.000 technician = 400.000 against 1.000.000 sold.
  await expect(card(page, "Costos")).toContainText(formatAmount(400_000, "CLP"));
  await expect(card(page, "Margen")).toContainText(formatAmount(600_000, "CLP"));
  await expect(card(page, "Margen %")).toContainText("60%");

  await unassignRow(page, `${tag} cables provisorio`, [`${tag} cables provisorio`, `${formatAmount(100_000, "CLP")} CLP`, "no se borra"]);
  await expect(card(page, "Costos")).toContainText(formatAmount(300_000, "CLP"));
  await expect(card(page, "Margen")).toContainText(formatAmount(700_000, "CLP"));
  await expect(card(page, "Margen %")).toContainText("70%");
  // The document stays, with its line, unassigned and ready to assign again.
  expect(await count("cost_lines", "cost_document_id", ids.provisional)).toBe(1);
  const { data: kept } = await admin().from("cost_documents").select("classification, project_id, total_amount").eq("id", ids.provisional).single();
  expect(kept).toMatchObject({ classification: "general", project_id: null, total_amount: 100_000 });

  // The technician's charge: the dialog sends to Técnicos, nothing is removed.
  const laborRow = page.getByRole("row").filter({ hasText: "Mano de obra" }).filter({ has: page.getByRole("button", { name: "Quitar del trabajo" }) });
  await laborRow.getByRole("button", { name: "Quitar del trabajo" }).click();
  const dialog = page.getByRole("dialog", { name: "Quitar gasto del trabajo" });
  await expect(dialog).toContainText("cargo de un técnico");
  await expect(dialog.getByRole("button", { name: "Sí, quitar" })).toHaveCount(0);
  await expect(dialog.getByRole("link", { name: "Ir a Corregir cargo" })).toHaveAttribute(
    "href",
    `/companies/${ids.cl}/projects/${ids.project}/technician-charges/${ids.charge}/edit`,
  );
  await dialog.getByRole("button", { name: "Cerrar" }).click();
  expect(await count("cost_documents", "id", ids.chargeDoc)).toBe(1);

  // The database refuses it too, whoever calls.
  const direct = await member.client.rpc("delete_cost_document", { p_cost_document_id: ids.chargeDoc });
  expect(direct.error?.message).toMatch(/cargo de un técnico/);
  expect(await count("technician_charges", "id", ids.charge)).toBe(1);
});

test("document page: deletes a confirmed expense with its receipt and goes back to the job", async ({ page, context }) => {
  await signIn(context, member);
  await page.goto(`/companies/${ids.cl}/costs/${ids.withReceipt}?projectId=${ids.project}`);
  await page.getByRole("button", { name: "Eliminar" }).click();
  const dialog = page.getByRole("dialog", { name: "Eliminar gasto" });
  await expect(dialog).toContainText(`${tag} equipos con boleta`);
  await expect(dialog).toContainText(`${formatAmount(200_000, "CLP")} CLP`);
  await dialog.getByRole("button", { name: "Sí, eliminar" }).click();
  await page.waitForURL(new RegExp(`/projects/${ids.project}$`));
  await expect(card(page, "Costos")).toContainText(formatAmount(100_000, "CLP"));
  await expect(card(page, "Margen %")).toContainText("90%");

  expect(await count("cost_documents", "id", ids.withReceipt)).toBe(0);
  expect(await count("cost_document_attachments", "cost_document_id", ids.withReceipt)).toBe(0);
  const { data: files } = await admin().storage.from("cost-receipts").list(`${ids.cl}/${ids.withReceipt}`);
  expect(files ?? []).toEqual([]);
});

test("Costos: deletes one assigned to a recurring service and an imported one, which the next import creates again", async ({ page, context }) => {
  await signIn(context, member);
  await page.goto(`/companies/${ids.cl}/costs?period=all`);

  await deleteRow(page, supplier.serviceName, [supplier.serviceName, `${formatAmount(36_999, "CLP")} CLP`]);
  expect(await count("cost_documents", "id", ids.serviceDoc)).toBe(0);
  expect(await count("cost_service_allocations", "cost_document_id", ids.serviceDoc)).toBe(0);
  expect(await count("recurring_service_cost_periods", "id", ids.costPeriod)).toBe(1);

  await deleteRow(page, supplier.importName, [supplier.importName, `${formatAmount(59_500, "CLP")} CLP`]);
  expect(await count("cost_documents", "id", ids.imported)).toBe(0);
  const { data: marked } = await admin()
    .from("cost_import_rows")
    .select("cost_document_id, deleted_at, deleted_supplier_id, deleted_document_date, deleted_total_amount")
    .eq("status", "imported")
    .eq("deleted_supplier_id", supplier.importId);
  expect(marked).toHaveLength(1);
  expect(marked?.[0]).toMatchObject({ cost_document_id: null, deleted_document_date: "2026-10-08", deleted_total_amount: 59500 });

  // No document exists, so the preview finds no duplicate...
  const previewFile = {
    name: `${tag}.csv`,
    mimeType: "text/csv",
    buffer: Buffer.from(`fecha,proveedor,monto neto,iva\n08/10/2026,${supplier.importName},50000,9500\n`),
  };
  await page.goto(`/companies/${ids.cl}/costs/import`);
  // The file input reacts only once the form is hydrated.
  await page.waitForLoadState("networkidle");
  await page.setInputFiles('input[type="file"]', previewFile);
  await page.getByRole("button", { name: "Previsualizar" }).click();
  await expect(page.getByText("Posible duplicado")).toHaveCount(0);

  // ...and importing the same invoice again creates it.
  const again = await importOnce();
  expect(again.status).toBe("imported");
  const { count: docs } = await admin().from("cost_documents").select("id", { count: "exact", head: true }).eq("supplier_id", supplier.importId);
  expect(docs).toBe(1);

  // Now it does exist: a duplicate, unless forced.
  await page.goto(`/companies/${ids.cl}/costs/import`);
  await page.waitForLoadState("networkidle");
  await page.setInputFiles('input[type="file"]', previewFile);
  await page.getByRole("button", { name: "Previsualizar" }).click();
  await expect(page.getByText("Posible duplicado")).toBeVisible();
  expect((await importOnce()).status).toBe("duplicate");
  expect((await importOnce(true)).status).toBe("imported");
});

test("Uruguay: takes an expense off the job, whose costs go to zero, and the document stays", async ({ page, context }) => {
  await signIn(context, member);
  await page.goto(`/companies/${ids.uy}/projects/${ids.uyProject}`);
  await expect(card(page, "Costos")).toContainText(formatAmount(5_000, "UYU"));
  await unassignRow(page, `${tag} materiales UY`, [`${tag} materiales UY`, `${formatAmount(5_000, "UYU")} UYU`]);
  await expect(card(page, "Costos")).toContainText(formatAmount(0, "UYU"));
  await expect(page.getByText("Todavía no hay gastos cargados en este trabajo.")).toBeVisible();
  expect(await count("cost_documents", "id", ids.uyDoc)).toBe(1);
});
