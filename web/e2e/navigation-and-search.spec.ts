/**
 * The way around Costos, Ventas and Proyectos, on a throwaway company in
 * inma-erp-dev, in a real browser: Proyectos opens on the board; "Volver" comes
 * back to the list with its month and sort, also after saving and on a page
 * opened straight from a link; a search finds a document of any month and is
 * read from the server a page at a time; the document number shows in the list;
 * a job links to its invoices; and no field offers the browser's autocomplete.
 * Run with `npm run test:e2e` after `npm run build`.
 */
import { expect, test } from "@playwright/test";
import {
  admin,
  assertDev,
  createCompany,
  createMember,
  deleteCompanies,
  deleteUser,
  newTag,
  ok,
  signIn,
  type Member,
} from "./helpers/devSession";

const tag = newTag();
const ids = { company: "", client: "", project: "", october: "", january: "", sale: "", area: "" };
let member: Member;

test.describe.configure({ mode: "serial" });

const base = () => `/companies/${ids.company}`;

async function cost(date: string, number: string, supplierId: string, total: number) {
  const row = await ok<{ id: string }>(
    admin()
      .from("cost_documents")
      .insert({
        company_id: ids.company,
        supplier_id: supplierId,
        classification: "general",
        document_date: date,
        currency: "CLP",
        net_amount: total,
        tax_amount: 0,
        total_amount: total,
        source_document_type: "FAC-EL",
        document_number: number,
        source: "manual",
        status: "confirmed",
      })
      .select("id")
      .single(),
    "cost",
  );
  return row.id;
}

test.beforeAll(async () => {
  assertDev();
  const db = admin();
  ids.company = await createCompany(`${tag} CL`, "CL", "CLP");
  member = await createMember(tag, [ids.company]);
  ids.client = (await ok<{ id: string }>(db.from("clients").insert({ company_id: ids.company, name: `${tag} cliente` }).select("id").single(), "client")).id;
  ids.area = (await ok<{ id: string }>(db.from("business_areas").insert({ company_id: ids.company, name: `${tag} area` }).select("id").single(), "area")).id;
  ids.project = (
    await ok<{ id: string }>(
      db.from("projects").insert({ company_id: ids.company, client_id: ids.client, business_area_id: ids.area, name: `${tag} trabajo`, status: "en_ejecucion" }).select("id").single(),
      "project",
    )
  ).id;
  const supplier = await ok<{ id: string }>(db.from("suppliers").insert({ company_id: ids.company, name: `${tag} proveedor`, tax_id: "11222333-4" }).select("id").single(), "supplier");
  ids.october = await cost("2026-10-05", "7001", supplier.id, 1000);
  ids.january = await cost("2024-01-15", "7002", supplier.id, 2000);
  ids.sale = (
    await ok<{ id: string }>(
      db
        .from("sales_documents")
        .insert({ company_id: ids.company, client_id: ids.client, project_id: ids.project, document_type: "invoice", document_number: "8181", document_date: "2023-02-01", currency: "CLP", net_amount: 1000, tax_amount: 190, total_amount: 1190 })
        .select("id")
        .single(),
      "sale",
    )
  ).id;
});

test.afterAll(async () => {
  const failures = [...(await deleteCompanies([ids.company].filter(Boolean))), ...(await deleteUser(member?.userId))];
  expect(failures).toEqual([]);
});

test("Proyectos opens on the board and the list is one click away", async ({ page, context }) => {
  await signIn(context, member);
  await page.goto(`${base()}/projects`);
  await expect(page).toHaveURL(new RegExp(`${base()}/projects/board$`));
  await expect(page.getByRole("heading", { name: "Tablero" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Proyectos" })).toHaveAttribute("aria-current", "page");

  await page.getByRole("link", { name: "Lista" }).click();
  await expect(page).toHaveURL(new RegExp(`${base()}/projects\\?vista=lista$`));
  await page.getByRole("link", { name: "Finalizados" }).click();
  await expect(page).toHaveURL(/vista=lista&estado=finalizados/);
  await expect(page.getByRole("heading", { name: "Proyectos", exact: true })).toBeVisible();
});

test("Costos: Volver comes back to the month and sort on screen, not the current month", async ({ page, context }) => {
  await signIn(context, member);
  const list = `${base()}/costs?period=2024-01&sort=total&order=asc`;
  await page.goto(list);
  const row = page.getByRole("row").filter({ hasText: "FAC-EL 7002" });
  await expect(row).toBeVisible();

  await row.getByRole("link", { name: "Ver" }).click();
  await expect(page).toHaveURL(new RegExp(`/costs/${ids.january}\\?volver=`));
  await expect(page.getByText("FAC-EL 7002").first()).toBeVisible();

  await page.getByRole("link", { name: "← Volver a Costos" }).first().click();
  await expect(page).toHaveURL(/period=2024-01/);
  await expect(page).toHaveURL(/sort=total/);
  await expect(page.getByRole("row").filter({ hasText: "FAC-EL 7002" })).toBeVisible();
});

test("Costos: Volver works on a page opened straight from a link, without history", async ({ page, context }) => {
  await signIn(context, member);
  const list = `${base()}/costs?period=2024-01`;
  await page.goto(`${base()}/costs/${ids.january}?volver=${encodeURIComponent(list)}`);
  await page.getByRole("link", { name: "← Volver a Costos" }).first().click();
  await expect(page).toHaveURL(/costs\?period=2024-01$/);

  // A target outside the company is ignored.
  await page.goto(`${base()}/costs/${ids.january}?volver=${encodeURIComponent("https://example.com/x")}`);
  await expect(page.getByRole("link", { name: "← Volver a documentos de costo" }).first()).toHaveAttribute("href", `${base()}/costs`);
});

test("Costos: assigning goes back to the list with its month", async ({ page, context }) => {
  await signIn(context, member);
  await page.goto(`${base()}/costs?period=2026-10`);
  await page.getByRole("row").filter({ hasText: "FAC-EL 7001" }).getByRole("link", { name: "Asignar a un trabajo" }).click();
  await page.locator("#project_id").click();
  await page.getByRole("button", { name: `${tag} trabajo` }).click();
  await page.getByRole("button", { name: /Asignar|Guardar/ }).last().click();
  await expect(page).toHaveURL(/costs\?period=2026-10$/);
  await expect(page.getByRole("row").filter({ hasText: "FAC-EL 7001" })).toContainText(`${tag} trabajo`);
});

test("the document number shows in Costos and on the job", async ({ page, context }) => {
  await signIn(context, member);
  await page.goto(`${base()}/costs?period=2026-10`);
  await expect(page.getByRole("cell", { name: "Documento", exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: "FAC-EL 7001", exact: true })).toBeVisible();

  await page.goto(`${base()}/projects/${ids.project}`);
  await expect(page.getByRole("row").filter({ hasText: "FAC-EL 7001" })).toBeVisible();
});

test("a job links to its invoices, and the invoice comes back to the job", async ({ page, context }) => {
  await signIn(context, member);
  await page.goto(`${base()}/projects/board`);
  await page.getByRole("link", { name: `${tag} trabajo` }).click();
  await expect(page.getByRole("link", { name: "← Volver al tablero" })).toBeVisible();

  await page.getByRole("link", { name: "FAC 8181" }).click();
  await expect(page).toHaveURL(new RegExp(`/sales/${ids.sale}/edit`));
  await page.getByRole("link", { name: "← Volver al trabajo" }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${ids.project}`));
  await page.getByRole("link", { name: "← Volver al tablero" }).click();
  await expect(page).toHaveURL(/projects\/board/);
});

test("search finds a document of any month, from the server", async ({ page, context }) => {
  await signIn(context, member);
  await page.goto(`${base()}/costs?period=2026-10`);
  await expect(page.getByRole("row").filter({ hasText: "FAC-EL 7002" })).toHaveCount(0);

  await page.getByRole("searchbox", { name: "Buscar documentos de costo" }).fill("7002");
  await expect(page).toHaveURL(/q=7002/);
  await expect(page.getByRole("row").filter({ hasText: "FAC-EL 7002" })).toBeVisible();
  await expect(page.getByText("1 resultado en todo el historial")).toBeVisible();

  // Clearing it returns to the month it was opened from.
  await page.getByRole("searchbox", { name: "Buscar documentos de costo" }).fill("");
  await expect(page).toHaveURL(/costs\?period=2026-10$/);

  await page.goto(`${base()}/sales?period=2026-10`);
  await page.getByRole("searchbox", { name: "Buscar documentos de venta" }).fill("8181");
  await expect(page.getByRole("row").filter({ hasText: "FAC 8181" })).toBeVisible();
});

test("no field offers the browser's autocomplete, except the login", async ({ page, context }) => {
  await signIn(context, member);
  for (const path of [`${base()}/clients/new`, `${base()}/recurring-services/services/new`, `${base()}/costs/new`, `${base()}/sales?period=all`]) {
    await page.goto(path);
    const fields = page.locator(
      'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="file"]):not([type="submit"]):not([type="button"]), select, textarea',
    );
    await expect(fields.first()).toBeVisible();
    const offenders = await fields.evaluateAll((elements) =>
      elements
        .filter((element) => (element.getAttribute("autocomplete") ?? "") !== "off")
        .map((element) => element.getAttribute("name") ?? element.id ?? element.tagName),
    );
    expect(offenders, path).toEqual([]);
  }
  await page.goto(`${base()}/recurring-services/services/new`);
  await expect(page.locator("#service_type")).toHaveAttribute("autocomplete", "off");
});
