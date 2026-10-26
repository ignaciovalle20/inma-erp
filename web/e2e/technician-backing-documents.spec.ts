/**
 * Técnicos externos in Chile (20261026010000), on throwaway companies in
 * inma-erp-dev: the charge form takes its backing from the ficha and shows
 * the breakdown as you type (boleta: líquido 375.000 in 2026 -> bruto 442.478,
 * retención 15,25 % 67.478; factura: neto 100.000 <-> total 119.000); the
 * charge is linked to the technician's imported boleta from the job
 * ("Vincular documento"), and the cuenta corriente lists it under
 * "Documentos recibidos". Uruguay keeps the amount + "IVA incluido" form.
 * Run with `npm run test:e2e` after `npm run build`.
 */
import { expect, test, type Page } from "@playwright/test";
import { admin, assertDev, createCompany, createMember, deleteCompanies, deleteUser, newTag, ok, signIn, type Member } from "./helpers/devSession";

const tag = newTag();
const ids = { cl: "", uy: "", project: "", projectUy: "", tech: "", techUy: "", supplier: "", doc: "", charge: "" };
let member: Member;

test.describe.configure({ mode: "serial" });

async function job(company: string, name: string): Promise<string> {
  const db = admin();
  const client = await ok<{ id: string }>(db.from("clients").insert({ company_id: company, name: `${tag} cliente` }).select("id").single(), "client");
  const area = await ok<{ id: string }>(db.from("business_areas").insert({ company_id: company, name: `${tag} area` }).select("id").single(), "area");
  const project = await ok<{ id: string }>(
    db
      .from("projects")
      .insert({ company_id: company, client_id: client.id, business_area_id: area.id, name, status: "en_ejecucion" })
      .select("id")
      .single(),
    "project",
  );
  return project.id;
}

test.beforeAll(async () => {
  assertDev();
  ids.cl = await createCompany(`${tag} CL`, "CL", "CLP");
  ids.uy = await createCompany(`${tag} UY`, "UY", "UYU");
  ids.project = await job(ids.cl, `${tag} instalación`);
  ids.projectUy = await job(ids.uy, `${tag} visita UY`);
  member = await createMember(tag, [ids.cl, ids.uy]);

  const tech = await ok<{ id: string }>(
    member.client
      .from("personnel")
      .insert({ company_id: ids.cl, name: `${tag} Ana Soto`, type: "contractor", tax_id: "15.555.555-5", default_backing: "boleta" })
      .select("id")
      .single(),
    "technician",
  );
  ids.tech = tech.id;
  const techUy = await ok<{ id: string }>(
    member.client
      .from("personnel")
      .insert({ company_id: ids.uy, name: `${tag} Técnico UY`, type: "contractor", payment_document: "factura" })
      .select("id")
      .single(),
    "technician UY",
  );
  ids.techUy = techUy.id;
  // Created with the technician's RUT (another format): linked to her by the database.
  const supplier = await ok<{ id: string }>(
    member.client.from("suppliers").insert({ company_id: ids.cl, name: `${tag} Ana Soto`, tax_id: "15555555-5" }).select("id").single(),
    "supplier",
  );
  ids.supplier = supplier.id;
});

test.afterAll(async () => {
  if (ids.doc && member) {
    await member.client.rpc("unlink_technician_document", { p_cost_document_id: ids.doc });
  }
  const failures = [...(await deleteCompanies([ids.cl, ids.uy].filter(Boolean))), ...(await deleteUser(member?.userId))];
  expect(failures).toEqual([]);
});

const breakdown = (page: Page) => page.getByTestId("charge-breakdown");

test("the charge form takes the backing from the ficha and shows the breakdown live", async ({ page, context }) => {
  await signIn(context, member);
  await page.goto(`/companies/${ids.cl}/projects/${ids.project}/technician-charges/new`);
  await page.locator("#personnel_id").selectOption(ids.tech);
  await expect(page.locator("#backing")).toHaveValue("boleta");
  await expect(page.getByRole("radio", { name: "Líquido" })).toHaveAttribute("aria-checked", "true");

  await page.locator("#charge_date").fill("2026-10-05");
  await page.locator("#amount").fill("375.000");
  await expect(breakdown(page)).toContainText("Bruto");
  await expect(breakdown(page)).toContainText("442.478");
  await expect(breakdown(page)).toContainText("Retención 15,25%");
  await expect(breakdown(page)).toContainText("67.478");
  await expect(breakdown(page)).toContainText("375.000");
  await page.screenshot({ path: test.info().outputPath("boleta-liquido.png"), fullPage: true });

  await page.getByRole("radio", { name: "Bruto" }).click();
  await page.locator("#amount").fill("442478");
  await expect(breakdown(page)).toContainText("67.478");
  await expect(breakdown(page)).toContainText("A pagar al técnico 375.000");

  await page.locator("#backing").selectOption("factura");
  await expect(page.getByRole("radio", { name: "Neto" })).toHaveAttribute("aria-checked", "true");
  await page.locator("#amount").fill("100000");
  await expect(breakdown(page)).toContainText("19.000");
  await expect(breakdown(page)).toContainText("119.000");
  await page.getByRole("radio", { name: "Total con IVA" }).click();
  await page.locator("#amount").fill("119.000");
  await expect(breakdown(page)).toContainText("Costo del trabajo 100.000");

  await page.locator("#backing").selectOption("none");
  await page.locator("#amount").fill("85000");
  await expect(breakdown(page)).toContainText("85.000");
  await expect(breakdown(page)).toContainText("Sin documento que vincular");

  // Saved as the boleta of 375.000 líquido.
  await page.locator("#backing").selectOption("boleta");
  await page.getByRole("radio", { name: "Líquido" }).click();
  await page.locator("#amount").fill("375000");
  await page.getByRole("button", { name: "Registrar cargo" }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${ids.project}$`), { timeout: 30_000 });
  await expect(page.getByText("Boleta de honorarios").first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Vincular documento" })).toBeVisible();

  const [charge] = await ok<{ id: string; amount: number; net_amount: number; backing: string }[]>(
    admin().from("technician_charges").select("id, amount, net_amount, backing").eq("company_id", ids.cl),
    "charge",
  );
  expect(charge).toMatchObject({ amount: 375000, net_amount: 442478, backing: "boleta" });
  ids.charge = charge.id;
});

test("the imported boleta is linked from the job, and the cuenta corriente lists it", async ({ page, context }) => {
  // The technician's boleta, imported from Nubox: bruto 442.478, líquido 375.000.
  const batch = await ok<{ id: string }>(
    member.client.rpc("create_cost_import_batch", { p_company_id: ids.cl, p_file_name: `${tag}.csv`, p_total_rows: 1 }),
    "batch",
  );
  const [row] = await ok<{ cost_document_id: string; status: string }[]>(
    member.client.rpc("import_cost_rows_batch", {
      p_import_batch_id: batch.id,
      p_rows: [
        {
          row_number: 1,
          raw_data: { "Tipo documento": "BOL-HE", "Nº documento": "33" },
          supplier_id: ids.supplier,
          document_date: "2026-10-20",
          currency: "CLP",
          amount: 442478,
          exempt_amount: 0,
          tax_amount: 0,
          other_taxes: 0,
          document_type: "invoice",
          source_document_type: "BOL-HE",
          document_number: "33",
          force: false,
          link_to_cost_document_id: null,
        },
      ],
    }),
    "import",
  );
  expect(row.status).toBe("imported");
  ids.doc = row.cost_document_id;

  await signIn(context, member);
  await page.goto(`/companies/${ids.cl}/projects/${ids.project}`);
  await page.getByRole("link", { name: "Vincular documento" }).click();
  await expect(page.getByRole("heading", { name: "Vincular documento" })).toBeVisible();
  await expect(page.getByText("BOL-HE 33")).toBeVisible();
  await page.getByRole("link", { name: "Elegir" }).click();

  await expect(page.getByRole("heading", { name: "Documento de un técnico" })).toBeVisible();
  await expect(page.getByTestId("link-sum")).toContainText("Cuadra");
  await page.screenshot({ path: test.info().outputPath("link.png"), fullPage: true });
  await page.getByRole("button", { name: "Vincular boleta" }).click();
  await expect(page.getByText("Cargos que cubre")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Desvincular" })).toBeVisible();

  const charge = await ok<{ document_status: string; cost_document_id: string | null }>(
    admin().from("technician_charges").select("document_status, cost_document_id").eq("id", ids.charge).single(),
    "linked charge",
  );
  // The charge keeps its own cost (its job, its month); the boleta only backs it (20261028010000).
  expect(charge.document_status).toBe("recibida");
  expect(charge.cost_document_id).not.toBeNull();
  const document = await ok<{ classification: string; project_id: string | null; technician_linked_amount: number }>(
    admin().from("cost_documents").select("classification, project_id, technician_linked_amount").eq("id", ids.doc).single(),
    "document",
  );
  expect(document).toEqual({ classification: "general", project_id: null, technician_linked_amount: 442478 });

  // Its assignment screens are locked while linked.
  await page.goto(`/companies/${ids.cl}/costs/${ids.doc}/allocate`);
  await expect(page.getByText("Vinculada a cargos de técnico — desvinculá para cambiar.")).toBeVisible();

  await page.goto(`/companies/${ids.cl}/personnel/${ids.tech}/account`);
  await expect(page.getByRole("heading", { name: "Documentos recibidos" })).toBeVisible();
  await expect(page.getByRole("link", { name: "BOL-HE 33" }).first()).toBeVisible();
  await expect(page.getByText("Respaldo habitual")).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("account.png"), fullPage: true });
});

test("Uruguay keeps the amount and 'IVA incluido' form, without backing", async ({ page, context }) => {
  await signIn(context, member);
  await page.goto(`/companies/${ids.uy}/projects/${ids.projectUy}/technician-charges/new`);
  await page.locator("#personnel_id").selectOption(ids.techUy);
  await expect(page.getByText("El monto incluye IVA (22%)")).toBeVisible();
  await expect(page.locator("#backing")).toHaveCount(0);
  await page.locator("#amount").fill("12.200");
  await expect(breakdown(page)).toContainText("Costo del trabajo (sin IVA)");
  await expect(breakdown(page)).toContainText("10.000");
  await page.getByRole("button", { name: "Registrar cargo" }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${ids.projectUy}$`), { timeout: 30_000 });
  await expect(page.getByRole("button", { name: /Marcar factura recibida/i })).toBeVisible();
});
