/**
 * "Editar asignación" after "Guardar asignación" (bug of 2026-10-26): the
 * rows were saved right, but every row then showed the same destination (the
 * first of the list) until the page was reloaded. React resets a form after
 * its action finishes, and the controlled <select>s went back to their first
 * enabled option in the DOM. Four rows with four different jobs, saved:
 * each row keeps showing its own job, right after saving and after reopening.
 * Throwaway Chilean company in inma-erp-dev. Run with `npm run test:e2e`
 * after `npm run build`.
 */
import { expect, test, type Page } from "@playwright/test";
import { admin, assertDev, createCompany, createMember, deleteCompanies, deleteUser, newTag, ok, signIn, type Member } from "./helpers/devSession";

const tag = newTag();
const TOTAL = 400_000;
const ids = { company: "", doc: "", projects: [] as string[] };
let member: Member;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  assertDev();
  const db = admin();
  ids.company = await createCompany(`${tag} CL`, "CL", "CLP");
  const client = await ok<{ id: string }>(db.from("clients").insert({ company_id: ids.company, name: `${tag} cliente` }).select("id").single(), "client");
  const area = await ok<{ id: string }>(db.from("business_areas").insert({ company_id: ids.company, name: `${tag} area` }).select("id").single(), "area");
  for (const n of [1, 2, 3, 4]) {
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
        p_lines: [{ description: `${tag} gasto compartido`, amount: TOTAL }],
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

const destination = (page: Page, row: number) => page.locator('select[name="target_id"]').nth(row);
const kind = (page: Page, row: number) => page.locator('select[name="target_type"]').nth(row);

test("four rows with four different jobs keep their job after saving and after reopening", async ({ page, context }) => {
  await signIn(context, member);
  await page.goto(`/companies/${ids.company}/costs/${ids.doc}/allocate`);
  await expect(page.getByRole("heading", { name: "Editar asignación" })).toBeVisible();

  await page.getByRole("button", { name: "+ Agregar destino" }).click();
  await page.getByRole("button", { name: "+ Agregar destino" }).click();
  // Not the creation order: 2, 4, 1, 3. None is the first of the list in row 2-4.
  const order = [2, 4, 1, 3];
  for (const [row, n] of order.entries()) {
    await kind(page, row).selectOption("project");
    await destination(page, row).selectOption(ids.projects[n - 1]);
  }
  await page.getByRole("button", { name: "Partes iguales" }).click();
  await page.getByRole("button", { name: "Guardar asignación" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Asignación guardada." })).toBeVisible();

  // Right after saving, without reloading: each row still shows its own job.
  for (const [row, n] of order.entries()) {
    await expect(destination(page, row)).toHaveValue(ids.projects[n - 1]);
    await expect(kind(page, row)).toHaveValue("project");
  }
  await page.screenshot({ path: test.info().outputPath("after-save.png"), fullPage: true });

  const saved = await ok<{ project_id: string; position: number; amount: number }[]>(
    admin().from("cost_allocations").select("project_id, position, amount").eq("cost_document_id", ids.doc).order("position"),
    "saved allocations",
  );
  expect(saved).toEqual(order.map((n, position) => ({ project_id: ids.projects[n - 1], position, amount: TOTAL / 4 })));

  // Saving again from the same screen keeps them too.
  await page.getByRole("button", { name: "Guardar asignación" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Asignación guardada." })).toBeVisible();
  for (const [row, n] of order.entries()) await expect(destination(page, row)).toHaveValue(ids.projects[n - 1]);

  await page.reload();
  for (const [row, n] of order.entries()) await expect(destination(page, row)).toHaveValue(ids.projects[n - 1]);
});
