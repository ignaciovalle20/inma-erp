/**
 * Mixed allocation in "Editar asignación" (20261025010000), on a throwaway
 * Chilean company in inma-erp-dev: one purchase invoice (100.000 net +
 * IVA = 119.000) goes 23.800 to a recurring service's October cost period
 * (20.000 net) and the rest to an area. The service row shows its net, the
 * save stores both parts, the page reopens them in order, the document page
 * shows both, and "Asignar a servicios" sends you back here. Run with
 * `npm run test:e2e` after `npm run build`.
 */
import { expect, test, type Page } from "@playwright/test";
import { admin, assertDev, createCompany, createMember, deleteCompanies, deleteUser, newTag, ok, signIn, type Member } from "./helpers/devSession";

const tag = newTag();
const ids = { company: "", doc: "", area: "", period: "" };
let member: Member;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  assertDev();
  const db = admin();
  ids.company = await createCompany(`${tag} CL`, "CL", "CLP");
  const client = await ok<{ id: string }>(db.from("clients").insert({ company_id: ids.company, name: `${tag} cliente` }).select("id").single(), "client");
  const area = await ok<{ id: string }>(db.from("business_areas").insert({ company_id: ids.company, name: `${tag} area` }).select("id").single(), "area");
  ids.area = area.id;
  const supplier = await ok<{ id: string }>(db.from("suppliers").insert({ company_id: ids.company, name: `${tag} Starlink` }).select("id").single(), "supplier");
  member = await createMember(tag, [ids.company]);
  const service = await ok<{ id: string }>(
    member.client
      .from("recurring_services")
      .insert({
        company_id: ids.company,
        client_id: client.id,
        name: `${tag} Starlink oficina`,
        currency: "CLP",
        reference_amount: 80000,
        periodicity: "monthly",
        invoicing_mode: "advance",
        start_date: "2026-10-01",
        end_date: "2026-10-31",
        service_type: "starlink",
        fixed_cost: 20000,
        cost_periodicity: "monthly",
        supplier_id: supplier.id,
        status: "active",
        active: true,
      })
      .select("id")
      .single(),
    "service",
  );
  const period = await ok<{ id: string }>(
    db.from("recurring_service_cost_periods").select("id").eq("recurring_service_id", service.id).eq("period", "2026-10-01").single(),
    "cost period",
  );
  ids.period = period.id;
  const doc = await ok<{ id: string }>(
    member.client
      .rpc("create_cost_document", {
        p_company_id: ids.company,
        p_supplier_id: supplier.id,
        p_project_id: null,
        p_classification: "general",
        p_document_date: "2026-10-05",
        p_currency: "CLP",
        p_tax_amount: 19000,
        p_lines: [{ description: `${tag} Starlink + soporte`, amount: 100000 }],
      })
      .select()
      .single(),
    "purchase invoice",
  );
  ids.doc = doc.id;
});

test.afterAll(async () => {
  const failures = [...(await deleteCompanies([ids.company].filter(Boolean))), ...(await deleteUser(member?.userId))];
  expect(failures).toEqual([]);
});

const amount = (page: Page, row: number) => page.getByLabel("Importe", { exact: true }).nth(row);
const targetType = (page: Page, row: number) => page.locator('select[name="target_type"]').nth(row);
const target = (page: Page, row: number) => page.locator('select[name="target_id"]').nth(row);
const save = (page: Page) => page.getByRole("button", { name: "Guardar asignación" });

async function open(page: Page) {
  await page.goto(`/companies/${ids.company}/costs/${ids.doc}/allocate`);
  await expect(page.getByRole("heading", { name: "Editar asignación" })).toBeVisible();
}

test("one invoice to a service and an area: shows the service's net, saves both parts, reopens them", async ({ page, context }) => {
  await signIn(context, member);
  await open(page);

  await targetType(page, 0).selectOption("service");
  await target(page, 0).selectOption(ids.period);
  await amount(page, 0).pressSequentially("23800");
  await expect(page.getByText("Neto al servicio: 20.000 CLP")).toBeVisible();

  await targetType(page, 1).selectOption("business_area");
  await target(page, 1).selectOption(ids.area);
  await amount(page, 1).click();
  await page.getByRole("button", { name: "Completar el faltante" }).click();
  await expect(amount(page, 1)).toHaveValue("95.200");
  await expect(page.getByText("Asignado completo")).toBeVisible();
  await expect(save(page)).toBeEnabled();
  await page.screenshot({ path: test.info().outputPath("mixed-form.png"), fullPage: true });

  await save(page).click();
  await expect(page.getByRole("status")).toHaveText("Asignación guardada.");

  const services = await ok<{ cost_period_id: string; amount: number; gross_amount: number; position: number }[]>(
    admin().from("cost_service_allocations").select("cost_period_id, amount, gross_amount, position").eq("cost_document_id", ids.doc),
    "service part",
  );
  expect(services.map((row) => ({ ...row, amount: Number(row.amount), gross_amount: Number(row.gross_amount) }))).toEqual([
    { cost_period_id: ids.period, amount: 20000, gross_amount: 23800, position: 0 },
  ]);
  const split = await ok<{ business_area_id: string; amount: number; position: number }[]>(
    admin().from("cost_allocations").select("business_area_id, amount, position").eq("cost_document_id", ids.doc),
    "split part",
  );
  expect(split.map((row) => ({ ...row, amount: Number(row.amount) }))).toEqual([{ business_area_id: ids.area, amount: 95200, position: 1 }]);

  // Reopened: same rows, same order, same amounts.
  await open(page);
  await expect(targetType(page, 0)).toHaveValue("service");
  await expect(target(page, 0)).toHaveValue(ids.period);
  await expect(amount(page, 0)).toHaveValue("23.800");
  await expect(targetType(page, 1)).toHaveValue("business_area");
  await expect(amount(page, 1)).toHaveValue("95.200");
  await expect(save(page)).toBeEnabled();
});

test("the same service period twice is flagged and blocks the save", async ({ page, context }) => {
  await signIn(context, member);
  await open(page);
  await page.getByRole("button", { name: "+ Agregar destino" }).click();
  await targetType(page, 2).selectOption("service");
  await target(page, 2).selectOption(ids.period);
  await expect(page.getByText("Este servicio y período ya está en otra fila.")).toBeVisible();
  await expect(save(page)).toBeDisabled();
});

test("the document shows both parts, and Asignar a servicios points back to Editar asignación", async ({ page, context }) => {
  await signIn(context, member);
  await page.goto(`/companies/${ids.company}/costs/${ids.doc}`);
  await expect(page.getByText("Asignado 100%")).toBeVisible();
  await expect(page.getByText("Servicios recurrentes (detalle arriba)")).toBeVisible();
  await expect(page.getByText(`${tag} Starlink oficina`)).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("mixed-detail.png"), fullPage: true });

  await page.goto(`/companies/${ids.company}/costs/${ids.doc}/services`);
  await expect(page.getByText("Editalo desde \"Editar asignación\"", { exact: false })).toBeVisible();
  await page.getByRole("link", { name: "Ir a Editar asignación" }).click();
  await expect(page.getByRole("heading", { name: "Editar asignación" })).toBeVisible();
});
