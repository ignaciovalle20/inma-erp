/**
 * "Editar asignación" of a general cost, on a throwaway Chilean company in
 * inma-erp-dev: percentage and amount are both editable on every row and
 * follow each other, amounts are whole pesos, "Partes iguales" and
 * "Completar el faltante" add up exactly, going over the total blocks the
 * save, and what is saved (the amounts) comes back when the page reopens.
 * Run with `npm run test:e2e` after `npm run build`.
 */
import { expect, test, type Page } from "@playwright/test";
import { admin, assertDev, createCompany, createMember, deleteCompanies, deleteUser, newTag, ok, signIn, type Member } from "./helpers/devSession";

const tag = newTag();
const TOTAL = 2_554_993;
const ids = { company: "", doc: "", projects: [] as string[] };
let member: Member;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  assertDev();
  const db = admin();
  ids.company = await createCompany(`${tag} CL`, "CL", "CLP");
  const client = await ok<{ id: string }>(db.from("clients").insert({ company_id: ids.company, name: `${tag} cliente` }).select("id").single(), "client");
  const area = await ok<{ id: string }>(db.from("business_areas").insert({ company_id: ids.company, name: `${tag} area` }).select("id").single(), "area");
  for (const n of [1, 2, 3]) {
    const project = await ok<{ id: string }>(
      db
        .from("projects")
        .insert({ company_id: ids.company, client_id: client.id, business_area_id: area.id, name: `${tag} trabajo ${n}`, status: "en_ejecucion" })
        .select("id")
        .single(),
      `project ${n}`,
    );
    ids.projects.push(project.id);
  }
  member = await createMember(tag, [ids.company]);
  const doc = await ok<{ id: string }>(
    member.client
      .rpc("create_cost_document", {
        p_company_id: ids.company,
        p_supplier_id: null,
        p_project_id: null,
        p_classification: "general",
        p_document_date: "2026-10-05",
        p_currency: "CLP",
        p_tax_amount: 0,
        p_lines: [{ description: `${tag} arriendo oficina`, amount: TOTAL }],
      })
      .select()
      .single(),
    "general cost",
  );
  ids.doc = doc.id;
});

test.afterAll(async () => {
  const failures = [...(await deleteCompanies([ids.company].filter(Boolean))), ...(await deleteUser(member?.userId))];
  expect(failures).toEqual([]);
});

const pct = (page: Page, row: number) => page.getByLabel("Porcentaje", { exact: true }).nth(row);
const amount = (page: Page, row: number) => page.getByLabel("Importe", { exact: true }).nth(row);
const save = (page: Page) => page.getByRole("button", { name: "Guardar asignación" });

async function pickProject(page: Page, row: number, n: number) {
  await page.locator('select[name="target_type"]').nth(row).selectOption("project");
  await page.locator('select[name="target_id"]').nth(row).selectOption(ids.projects[n - 1]);
}

async function open(page: Page) {
  await page.goto(`/companies/${ids.company}/costs/${ids.doc}/allocate`);
  await expect(page.getByRole("heading", { name: "Editar asignación" })).toBeVisible();
}

test("case 1: 78,28% plus 554.944 adds up, saves, and reopens with the same amounts (case 4)", async ({ page, context }) => {
  await signIn(context, member);
  await open(page);
  await pickProject(page, 0, 1);
  await pickProject(page, 1, 2);

  // Typed key by key: the field keeps what is typed (no caret jumps) and the amount follows.
  await pct(page, 0).pressSequentially("78,28");
  await expect(pct(page, 0)).toHaveValue("78,28");
  await expect(amount(page, 0)).toHaveValue("2.000.049");
  await expect(save(page)).toBeDisabled();

  await amount(page, 1).pressSequentially("554944");
  await expect(amount(page, 1)).toHaveValue("554.944");
  await expect(pct(page, 1)).toHaveValue("21,72");
  await expect(page.getByText("Asignado completo")).toBeVisible();
  await expect(save(page)).toBeEnabled();
  await page.screenshot({ path: test.info().outputPath("case1.png"), fullPage: true });

  await save(page).click();
  await expect(page.getByRole("status")).toHaveText("Asignación guardada.");

  const saved = await ok<{ method: string; amount: number; percentage: number | null }[]>(
    admin().from("cost_allocations").select("method, amount, percentage").eq("cost_document_id", ids.doc).order("amount", { ascending: false }),
    "saved allocations",
  );
  expect(saved).toEqual([
    { method: "fixed_amount", amount: 2000049, percentage: null },
    { method: "fixed_amount", amount: 554944, percentage: null },
  ]);

  // Case 4: editing it again loads the saved amounts and their percentages, in the same rows.
  await open(page);
  await expect(page.locator('select[name="target_id"]').nth(0)).toHaveValue(ids.projects[0]);
  await expect(amount(page, 0)).toHaveValue("2.000.049");
  await expect(pct(page, 0)).toHaveValue("78,28");
  await expect(amount(page, 1)).toHaveValue("554.944");
  await expect(pct(page, 1)).toHaveValue("21,72");
  await expect(save(page)).toBeEnabled();
  await page.screenshot({ path: test.info().outputPath("case4.png"), fullPage: true });
});

test("case 2: three equal parts add up exactly; Completar el faltante fills the active row", async ({ page, context }) => {
  await signIn(context, member);
  await open(page);
  await page.getByRole("button", { name: "+ Agregar destino" }).click();
  await pickProject(page, 2, 3);

  await page.getByRole("button", { name: "Partes iguales" }).click();
  await expect(amount(page, 0)).toHaveValue("851.664");
  await expect(amount(page, 1)).toHaveValue("851.664");
  await expect(amount(page, 2)).toHaveValue("851.665");
  await expect(pct(page, 0)).toHaveValue("33,33");
  await expect(page.getByText("Asignado completo")).toBeVisible();
  await expect(save(page)).toBeEnabled();
  await page.screenshot({ path: test.info().outputPath("case2.png"), fullPage: true });

  // Clear the middle row, then fill it back from the button.
  await amount(page, 1).fill("");
  await expect(page.getByText("Falta 851.664 CLP")).toBeVisible();
  await page.getByRole("button", { name: "Completar el faltante" }).click();
  await expect(amount(page, 1)).toHaveValue("851.664");
  await expect(save(page)).toBeEnabled();
});

test("case 3: an amount over the total is flagged and blocks the save", async ({ page, context }) => {
  await signIn(context, member);
  await open(page);
  // The saved 2.000.049 + 554.944 from case 1, the first row raised to 3.000.000.
  await amount(page, 0).fill("3.000.000");
  await expect(page.getByText("Te pasaste por 999.951 CLP")).toBeVisible();
  const flagged = page.locator('[aria-invalid="true"]');
  await expect(flagged).toHaveCount(1);
  await expect(flagged.getByLabel("Importe", { exact: true })).toHaveValue("3.000.000");
  await expect(save(page)).toBeDisabled();
  await page.screenshot({ path: test.info().outputPath("case3.png"), fullPage: true });
});

test("rows reopen in the order they were saved, every time", async ({ page, context }) => {
  await signIn(context, member);
  await open(page);
  await page.getByRole("button", { name: "+ Agregar destino" }).click();
  // Not the creation order of the projects: 3, 1, 2.
  const order = [3, 1, 2];
  for (const [row, n] of order.entries()) await pickProject(page, row, n);
  await page.getByRole("button", { name: "Partes iguales" }).click();
  await save(page).click();
  await expect(page.getByRole("status")).toHaveText("Asignación guardada.");

  const saved = await ok<{ project_id: string; position: number }[]>(
    admin().from("cost_allocations").select("project_id, position").eq("cost_document_id", ids.doc).order("position"),
    "saved positions",
  );
  expect(saved).toEqual(order.map((n, position) => ({ project_id: ids.projects[n - 1], position })));

  for (let reload = 0; reload < 3; reload++) {
    await open(page);
    for (const [row, n] of order.entries()) {
      await expect(page.locator('select[name="target_id"]').nth(row)).toHaveValue(ids.projects[n - 1]);
    }
    await expect(amount(page, 2)).toHaveValue("851.665");
  }
});
