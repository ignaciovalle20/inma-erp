/**
 * The FAC-EL 257 case, on a throwaway Chilean company in inma-erp-dev: a factura
 * issued with the RUT of the technician's company (neto 2.147.053, total
 * 2.554.993) covering 4 charges of 4 jobs. One has factura, one has none ("sin
 * respaldo", already paid), one is agreed in net and one does not exist and is
 * created from the same screen. Then a difference and a partial application.
 * Run with `npm run test:e2e` after `npm run build`.
 */
import { expect, test, type Page } from "@playwright/test";
import { admin, assertDev, createCompany, createMember, deleteCompanies, deleteUser, newTag, ok, signIn, type Member } from "./helpers/devSession";

const tag = newTag();
const NET = 2_147_053;
const ids = {
  company: "",
  tech: "",
  doc: "",
  projects: {} as Record<string, string>,
  charges: {} as Record<string, string>,
};
let member: Member;

test.describe.configure({ mode: "serial" });

const projectName = (name: string) => `${tag} ${name}`;

test.beforeAll(async () => {
  assertDev();
  const db = admin();
  ids.company = await createCompany(`${tag} CL`, "CL", "CLP");
  const client = await ok<{ id: string }>(db.from("clients").insert({ company_id: ids.company, name: `${tag} cliente` }).select("id").single(), "client");
  const area = await ok<{ id: string }>(db.from("business_areas").insert({ company_id: ids.company, name: `${tag} area` }).select("id").single(), "area");
  for (const name of ["Redes", "Starlink", "Tintas", "HIK"]) {
    const project = await ok<{ id: string }>(
      db
        .from("projects")
        .insert({ company_id: ids.company, client_id: client.id, business_area_id: area.id, name: projectName(name), status: "en_ejecucion" })
        .select("id")
        .single(),
      `project ${name}`,
    );
    ids.projects[name] = project.id;
  }
  member = await createMember(tag, [ids.company]);

  const tech = await ok<{ id: string }>(
    member.client
      .from("personnel")
      .insert({ company_id: ids.company, name: `${tag} Luis`, type: "contractor", tax_id: "13.765.872-0", default_backing: "factura" })
      .select("id")
      .single(),
    "technician",
  );
  ids.tech = tech.id;
  // The technician invoices with the RUT of their company, not the personal one.
  const supplier = await ok<{ id: string }>(
    member.client.from("suppliers").insert({ company_id: ids.company, name: `${tag} Luis E.I.R.L.`, tax_id: "76577457-8" }).select("id").single(),
    "supplier",
  );
  await ok(
    member.client.from("technician_suppliers").insert({ company_id: ids.company, personnel_id: tech.id, supplier_id: supplier.id }).select("id"),
    "technician supplier",
  );

  const charge = async (name: string, backing: string, enteredAs: string, value: number, date: string) => {
    const row = await ok<{ id: string }>(
      member.client.rpc("create_backed_technician_charge", {
        p_project_id: ids.projects[name],
        p_personnel_id: tech.id,
        p_description: null,
        p_charge_date: date,
        p_backing: backing,
        p_entered_as: enteredAs,
        p_value: value,
      }),
      `charge ${name}`,
    );
    ids.charges[name] = row.id;
  };
  await charge("Redes", "factura", "total", 2_000_000, "2026-06-15");
  await charge("Starlink", "none", "amount", 400_000, "2026-06-20");
  await charge("HIK", "factura", "net", 92_432, "2026-06-25");
  // The Starlink job was already paid: taking the factura must not touch that.
  const payment = await ok<unknown>(
    member.client.rpc("record_technician_payment", {
      p_personnel_id: tech.id,
      p_payment_date: "2026-06-21",
      p_amount: 400_000,
      p_method: null,
      p_notes: null,
      p_applications: [{ charge_id: ids.charges.Starlink, amount: 400_000 }],
    }),
    "payment",
  );
  expect(payment).toBeTruthy();

  const batch = await ok<{ id: string }>(
    member.client.rpc("create_cost_import_batch", { p_company_id: ids.company, p_file_name: `${tag}.csv`, p_total_rows: 1 }),
    "batch",
  );
  const [row] = await ok<{ cost_document_id: string; status: string }[]>(
    member.client.rpc("import_cost_rows_batch", {
      p_import_batch_id: batch.id,
      p_rows: [
        {
          row_number: 1,
          raw_data: { "Tipo documento": "FAC-EL", "Nº documento": "257" },
          supplier_id: supplier.id,
          document_date: "2026-06-30",
          currency: "CLP",
          amount: NET,
          exempt_amount: 0,
          tax_amount: 407_940,
          other_taxes: 0,
          document_type: "invoice",
          source_document_type: "FAC-EL",
          document_number: "257",
          force: false,
          link_to_cost_document_id: null,
        },
      ],
    }),
    "import",
  );
  expect(row.status).toBe("imported");
  ids.doc = row.cost_document_id;
});

test.afterAll(async () => {
  if (ids.doc && member) {
    await member.client.rpc("unlink_technician_document", { p_cost_document_id: ids.doc });
  }
  const failures = [...(await deleteCompanies([ids.company].filter(Boolean))), ...(await deleteUser(member?.userId))];
  expect(failures).toEqual([]);
});

const open = (page: Page) => page.goto(`/companies/${ids.company}/costs/${ids.doc}/technician`);
const sum = (page: Page) => page.getByTestId("link-sum");
const row = (page: Page, name: string) => page.getByTestId("link-charge").filter({ hasText: projectName(name) });
const pick = (page: Page, name: string) => row(page, name).getByRole("checkbox").check();
const applyInput = (page: Page, name: string) => page.getByLabel(`Aplicar a ${projectName(name)}`);

test("the document splits on its net, not on the total", async ({ page, context }) => {
  await signIn(context, member);
  await page.goto(`/companies/${ids.company}/costs/${ids.doc}/allocate`);
  await expect(page.getByText("Por repartir (neto)")).toBeVisible();
  await expect(page.getByText("2.147.053").first()).toBeVisible();
  await expect(page.getByText(/2\.554\.993 CLP: el IVA no se reparte/)).toBeVisible();
});

test("every pending charge shows up, whichever RUT issued it and whichever job it is on", async ({ page, context }) => {
  await signIn(context, member);
  await open(page);
  await expect(page.getByRole("heading", { name: "Documento de un técnico" })).toBeVisible();

  await expect(page.getByTestId("link-charge")).toHaveCount(3);
  await expect(row(page, "Redes")).toContainText("Neto 1.680.672 · IVA 319.328 · Total a pagar 2.000.000");
  await expect(row(page, "Starlink")).toContainText("Sin respaldo");
  await expect(row(page, "HIK")).toContainText("Neto 92.432");
  await expect(page.getByRole("button", { name: "Vincular factura" })).toBeDisabled();

  await pick(page, "Redes");
  await expect(sum(page)).toContainText("No cuadra");
  await expect(sum(page)).toContainText("Netos seleccionados 1.680.672");
  await expect(sum(page)).toContainText("Neto del documento 2.147.053");
  await expect(sum(page)).toContainText("Diferencia 466.381");
});

test("FAC-EL 257 against 4 charges of 4 jobs: one is created there, one takes the factura", async ({ page, context }) => {
  await signIn(context, member);
  await open(page);
  await pick(page, "Redes");
  await pick(page, "HIK");
  await pick(page, "Starlink");
  // Sin respaldo, read as the total with IVA: what it pays stays, the cost is the net.
  await expect(row(page, "Starlink")).toContainText("Neto 336.134 · IVA 63.866 · Total a pagar 400.000");
  await expect(applyInput(page, "Starlink")).toHaveValue("336.134");
  await expect(sum(page)).toContainText("Diferencia 37.815");

  // The fourth charge does not exist: created from here, it comes back selected.
  await page.getByRole("button", { name: "+ Crear un cargo que falta" }).click();
  await page.getByLabel("Proyecto del cargo nuevo").selectOption(ids.projects.Tintas);
  await expect(page.getByLabel("Monto del cargo nuevo", { exact: true })).toHaveValue("37.815");
  await expect(page.getByLabel("Cómo se ingresa el monto del cargo nuevo")).toHaveValue("net");
  await page.getByRole("button", { name: "Crear cargo" }).click();
  await expect(row(page, "Tintas").getByRole("checkbox")).toBeChecked({ timeout: 30_000 });

  await expect(sum(page)).toContainText("Cuadra");
  await expect(sum(page)).toContainText("Netos seleccionados 2.147.053 (4 cargos)");
  await expect(sum(page)).toContainText("Diferencia 0");
  await page.screenshot({ path: test.info().outputPath("selector.png"), fullPage: true });
  await page.getByRole("button", { name: "Vincular factura" }).click();
  await expect(page.getByText("Cargos que cubre")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("linked-sum")).toContainText("Aplicado 2.147.053");

  const links = await ok<{ charge_id: string; cost_amount: number }[]>(
    admin().from("technician_charge_documents").select("charge_id, cost_amount").eq("cost_document_id", ids.doc),
    "links",
  );
  expect(links.map((link) => Number(link.cost_amount)).sort((a, b) => a - b)).toEqual([37_815, 92_432, 336_134, 1_680_672]);

  // A cost of the technician, not of the supplier: nothing left as a general cost.
  const document = await ok<{ classification: string; project_id: string | null; technician_linked_amount: number }>(
    admin().from("cost_documents").select("classification, project_id, technician_linked_amount").eq("id", ids.doc).single(),
    "document",
  );
  expect(document).toEqual({ classification: "general", project_id: null, technician_linked_amount: NET });

  const charges = await ok<{ project_id: string; backing: string; net_amount: number; amount: number; document_status: string }[]>(
    admin().from("technician_charges").select("project_id, backing, net_amount, amount, document_status").eq("company_id", ids.company),
    "charges",
  );
  expect(charges).toHaveLength(4);
  for (const charge of charges) expect(charge.document_status).toBe("recibida");
  expect(charges.find((charge) => charge.project_id === ids.projects.Starlink)).toMatchObject({
    backing: "factura",
    net_amount: 336_134,
    amount: 400_000,
  });

  // The Starlink payment stands: nothing is owed on it.
  await page.goto(`/companies/${ids.company}/personnel/${ids.tech}/account`);
  await expect(page.getByRole("link", { name: "FAC-EL 257" }).first()).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("account.png"), fullPage: true });

  await page.goto(`/companies/${ids.company}/projects/${ids.projects.Redes}`);
  await expect(page.getByText("neto 1.680.672 · IVA 319.328 · total a pagar 2.000.000")).toBeVisible();
});

test("a difference needs an explicit confirmation, and a charge can be covered in part", async ({ page, context }) => {
  await ok(member.client.rpc("unlink_technician_document", { p_cost_document_id: ids.doc }), "unlink");
  await signIn(context, member);
  await open(page);
  await pick(page, "Redes");
  await applyInput(page, "Redes").fill("1.000.000");
  await expect(row(page, "Redes")).toContainText("Parcial: quedan 680.672 pendientes de documento.");
  await expect(sum(page)).toContainText("Diferencia 1.147.053");

  const link = page.getByRole("button", { name: "Vincular factura" });
  await expect(link).toBeDisabled();
  await page.getByRole("checkbox", { name: /Vincular igual con una diferencia de 1\.147\.053/ }).check();
  await expect(link).toBeEnabled();
  await link.click();
  await expect(page.getByText("Cargos que cubre")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("linked-sum")).toContainText("Diferencia 1.147.053");

  const charge = await ok<{ document_status: string }>(
    admin().from("technician_charges").select("document_status").eq("id", ids.charges.Redes).single(),
    "partial charge",
  );
  expect(charge.document_status).toBe("pendiente");
  const document = await ok<{ technician_linked_amount: number }>(
    admin().from("cost_documents").select("technician_linked_amount").eq("id", ids.doc).single(),
    "document",
  );
  expect(document.technician_linked_amount).toBe(1_000_000);

  await page.goto(`/companies/${ids.company}/projects/${ids.projects.Redes}`);
  await expect(page.getByText("Parcial: faltan 680.672")).toBeVisible();
  await expect(page.getByRole("link", { name: "Vincular otro documento" })).toBeVisible();
});
