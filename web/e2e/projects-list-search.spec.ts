/**
 * Projects list: Activos / Finalizados / Todos tabs (?estado=) and the
 * search box (?q=, debounced, server-side, case- and accent-insensitive,
 * across every status).
 *
 * Its own data, no seed (dev has none since it holds a copy of prod): a
 * throwaway Chilean company "QA-…" with a client with an accent in its name,
 * an active job ("… Red de oficina") and a finished one ("… Servidor de
 * archivos", with quote …-Q1002 and invoice …-F1003), and a member signed in
 * server-side (the session cookies are handed to the browser -- no
 * credentials are typed into the page). Everything is deleted in afterAll.
 * Run with `npm run test:e2e` after `npm run build`.
 */
import { expect, test, type Page } from "@playwright/test";
import {
  QA_PREFIX,
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

const tag = newTag(QA_PREFIX);
const ACTIVE_PROJECT = `${tag} Red de oficina`;
const FINISHED_PROJECT = `${tag} Servidor de archivos`;
const QUOTE = `${tag}-Q1002`;
const INVOICE = `${tag}-F1003`;
const ids = { company: "", client: "", active: "", finished: "" };
let member: Member;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  assertDev();
  const db = admin();
  ids.company = await createCompany(`${tag} CL`, "CL", "CLP");
  const client = await ok<{ id: string }>(
    db.from("clients").insert({ company_id: ids.company, name: `${tag} Cliente Démo Chile` }).select("id").single(),
    "client",
  );
  ids.client = client.id;
  const area = await ok<{ id: string }>(
    db.from("business_areas").insert({ company_id: ids.company, name: `${tag} Networking` }).select("id").single(),
    "area",
  );
  const project = async (name: string, status: string) =>
    (
      await ok<{ id: string }>(
        db
          .from("projects")
          .insert({ company_id: ids.company, client_id: client.id, business_area_id: area.id, name, status, start_date: "2026-08-01" })
          .select("id")
          .single(),
        name,
      )
    ).id;
  ids.active = await project(ACTIVE_PROJECT, "en_ejecucion");
  ids.finished = await project(FINISHED_PROJECT, "finalizado");
  await ok(
    db.from("project_quotes").insert({ company_id: ids.company, project_id: ids.finished, quote_number: QUOTE }).select("id"),
    "quote",
  );
  await ok(
    db
      .from("sales_documents")
      .insert({
        company_id: ids.company,
        client_id: client.id,
        project_id: ids.finished,
        business_area_id: area.id,
        document_type: "invoice",
        document_number: INVOICE,
        document_date: "2026-09-02",
        currency: "CLP",
        net_amount: 1000,
        tax_amount: 190,
        total_amount: 1190,
      })
      .select("id"),
    "invoice",
  );
  member = await createMember(tag, [ids.company]);
});

test.afterAll(async () => {
  const failures = [...(await deleteCompanies([ids.company].filter(Boolean))), ...(await deleteUser(member?.userId))];
  expect(failures).toEqual([]);
});

function projectRows(page: Page) {
  return page.locator("tbody tr");
}

const basePath = () => `/companies/${ids.company}/projects`;

test("Activos is the default tab and leaves finished jobs out", async ({ page, context }) => {
  await signIn(context, member);
  await page.goto(basePath());

  await expect(page.getByRole("link", { name: "Activos" })).toHaveAttribute("aria-current", "page");
  await expect(projectRows(page).filter({ hasText: ACTIVE_PROJECT })).toHaveCount(1);
  await expect(projectRows(page).filter({ hasText: FINISHED_PROJECT })).toHaveCount(0);
  await expect(page.locator("thead")).toContainText("Costo del mes");
  await expect(projectRows(page).filter({ hasText: ACTIVE_PROJECT })).toContainText("Pendiente");
});

test("Finalizados lists finished jobs with their closing date and a year picker", async ({ page, context }) => {
  await signIn(context, member);
  await page.goto(basePath());
  await page.getByRole("link", { name: "Finalizados" }).click();

  await expect(page).toHaveURL(/estado=finalizados/);
  const row = projectRows(page).filter({ hasText: FINISHED_PROJECT });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("Finalizado");
  await expect(projectRows(page).filter({ hasText: ACTIVE_PROJECT })).toHaveCount(0);

  const year = String(new Date().getFullYear());
  const yearPicker = page.getByLabel("Filtrar por año de cierre");
  await expect(yearPicker.locator("option", { hasText: year })).toHaveCount(1);
  await yearPicker.selectOption(year);
  await expect(page).toHaveURL(new RegExp(`anio=${year}`));
  await expect(projectRows(page).filter({ hasText: FINISHED_PROJECT })).toHaveCount(1);
});

test("Todos shows active and finished jobs", async ({ page, context }) => {
  await signIn(context, member);
  await page.goto(`${basePath()}?estado=todos`);

  await expect(projectRows(page).filter({ hasText: ACTIVE_PROJECT })).toHaveCount(1);
  await expect(projectRows(page).filter({ hasText: FINISHED_PROJECT })).toHaveCount(1);
});

test("document search finds receipts and manual sales, never credit notes nor annulled ones", async ({
  page,
  context,
}) => {
  const db = admin();
  const base = {
    company_id: ids.company,
    client_id: ids.client,
    project_id: ids.finished,
    document_date: "2026-01-15",
    currency: "CLP",
    net_amount: 1000,
    tax_amount: 190,
    total_amount: 1190,
    voided: false,
  };
  const docs = await ok<{ id: string; document_number: string }[]>(
    db
      .from("sales_documents")
      .insert([
        { ...base, document_type: "receipt", document_number: `${tag}-BOL` },
        { ...base, document_type: "manual", document_number: `${tag}-MAN` },
        { ...base, document_type: "credit_note", document_number: `${tag}-NCR` },
        { ...base, document_type: "receipt", document_number: `${tag}-BVOID`, voided: true },
        { ...base, document_type: "invoice", document_number: `${tag}-FANU` },
      ])
      .select("id, document_number"),
    "sales documents",
  );
  // A credit note that annuls the last invoice.
  const annulled = docs.find((doc) => doc.document_number === `${tag}-FANU`)!;
  const creditNote = await ok<{ id: string }>(
    db
      .from("sales_documents")
      .insert({ ...base, document_type: "credit_note", document_number: `${tag}-NCANU`, annuls_document_id: annulled.id })
      .select("id")
      .single(),
    "credit note",
  );
  await ok(db.from("sales_documents").update({ annulled_by_document_id: creditNote.id }).eq("id", annulled.id).select("id"), "annul");

  await signIn(context, member);
  await page.goto(basePath());
  const search = page.getByLabel("Buscar proyectos");

  for (const number of [`${tag}-BOL`, `${tag}-man`]) {
    await search.fill(number);
    await expect(page.getByText("1 resultado en todos los estados."), number).toBeVisible();
    await expect(projectRows(page).filter({ hasText: FINISHED_PROJECT }), number).toHaveCount(1);
  }
  for (const number of [`${tag}-NCR`, `${tag}-BVOID`, `${tag}-FANU`, `${tag}-NCANU`]) {
    await search.fill(number);
    await expect(page.getByText("0 resultados en todos los estados."), number).toBeVisible();
  }
});

test("a page past the end, or an absurd one, lands on the last page", async ({ page, context }) => {
  await signIn(context, member);

  for (const bad of ["7", "99999999999999999999"]) {
    await page.goto(`${basePath()}?estado=finalizados&page=${bad}`);
    await expect(page, `page=${bad}`).not.toHaveURL(/page=/);
    await expect(projectRows(page).filter({ hasText: FINISHED_PROJECT }), `page=${bad}`).toHaveCount(1);
  }

  await page.goto(`${basePath()}?q=servidor&page=3`);
  await expect(page).toHaveURL(/q=servidor/);
  await expect(page).not.toHaveURL(/page=/);
  await expect(projectRows(page).filter({ hasText: FINISHED_PROJECT })).toHaveCount(1);
});

test("search ignores accents, case and the open tab, and syncs ?q=", async ({ page, context }) => {
  await signIn(context, member);
  await page.goto(basePath());
  const search = page.getByLabel("Buscar proyectos");

  // Accented, upper case, from the Activos tab: finds the finished job.
  await search.fill("SERVIDÓR");
  await expect(page).toHaveURL(/q=SERVID%C3%93R/);
  const found = projectRows(page).filter({ hasText: FINISHED_PROJECT });
  await expect(found).toHaveCount(1);
  await expect(found).toContainText("Finalizado");
  await expect(page.getByText("1 resultado en todos los estados.")).toBeVisible();

  // Quote number and invoice number, in another case.
  await search.fill(QUOTE.toLowerCase());
  await expect(projectRows(page).filter({ hasText: FINISHED_PROJECT })).toHaveCount(1);
  await search.fill(INVOICE);
  await expect(projectRows(page).filter({ hasText: FINISHED_PROJECT })).toHaveCount(1);

  // Client name without accents or capitals matches both jobs.
  await search.fill("cliente demo chile");
  await expect(page.getByText("2 resultados en todos los estados.")).toBeVisible();

  // Loading the URL directly restores the box.
  await page.goto(`${basePath()}?q=red%20de%20oficina`);
  await expect(search).toHaveValue("red de oficina");
  await expect(projectRows(page).filter({ hasText: ACTIVE_PROJECT })).toHaveCount(1);

  // A tab link leaves the search.
  await page.getByRole("link", { name: "Todos" }).click();
  await expect(page).not.toHaveURL(/q=/);
  await expect(search).toHaveValue("");
});
