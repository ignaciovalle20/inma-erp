/**
 * Projects list: Activos / Finalizados / Todos tabs (?estado=) and the
 * search box (?q=, debounced, server-side, case- and accent-insensitive,
 * across every status).
 *
 * Reads the demo company of supabase/seed.sql in inma-erp-dev ("Demo -
 * Red de oficina" en_ejecucion, "Demo - Servidor de archivos" finalizado
 * with quote DEV-1002 and invoice DEV-F-1003). Runs as a throwaway member
 * created through the admin API and signed in server-side (the session
 * cookies are handed to the browser -- no credentials are typed into the
 * page). Only the user, its membership and a few sales documents on the
 * finished demo job (one test, numbered with the run's tag) are created,
 * and all of them are deleted in afterAll.
 */
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { loadEnvConfig } from "@next/env";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

loadEnvConfig(path.resolve(__dirname, ".."));

const DEV_PROJECT_REF = "sczgankronafrxybpvnh";
const DEMO_CHILE_COMPANY_ID = "a0000000-0000-4000-8000-000000000001";
const ACTIVE_PROJECT = "Demo - Red de oficina";
const FINISHED_PROJECT = "Demo - Servidor de archivos";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

const tag = `zz-test-e2e-${randomUUID().slice(0, 8)}`;
let userId = "";
let cookies: { name: string; value: string }[] = [];

function admin() {
  return createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
}

test.beforeAll(async () => {
  if (new URL(url).host !== `${DEV_PROJECT_REF}.supabase.co`) {
    throw new Error(`E2E only runs against inma-erp-dev (${DEV_PROJECT_REF}).`);
  }
  const db = admin();

  const email = `${tag}@example.test`;
  const password = randomBytes(24).toString("base64url");
  const { data: created, error: userError } = await db.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (userError) throw userError;
  userId = created.user.id;

  const { error: membershipError } = await db
    .from("company_memberships")
    .insert({ user_id: userId, company_id: DEMO_CHILE_COMPANY_ID, role: "member" });
  if (membershipError) throw membershipError;

  const jar = new Map<string, string>();
  const ssr = createServerClient(url, anonKey, {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (toSet) => toSet.forEach(({ name, value }) => jar.set(name, value)),
    },
  });
  const { error: signInError } = await ssr.auth.signInWithPassword({ email, password });
  if (signInError) throw signInError;
  cookies = [...jar].map(([name, value]) => ({ name, value }));
});

test.afterAll(async () => {
  const db = admin();
  // The sales documents one test adds to the finished demo job (one
  // statement: an annulled invoice and its credit note point at each other).
  await db.from("sales_documents").delete().eq("company_id", DEMO_CHILE_COMPANY_ID).like("document_number", `${tag}%`);
  if (!userId) return;
  await db.from("company_memberships").delete().eq("user_id", userId);
  await db.auth.admin.deleteUser(userId);
});

async function signIn(context: BrowserContext) {
  await context.addCookies(
    cookies.map((c) => ({ ...c, domain: "localhost", path: "/", sameSite: "Lax" as const })),
  );
}

function projectRows(page: Page) {
  return page.locator("tbody tr");
}

const basePath = `/companies/${DEMO_CHILE_COMPANY_ID}/projects`;

test("Activos is the default tab and leaves finished jobs out", async ({ page, context }) => {
  await signIn(context);
  await page.goto(basePath);

  await expect(page.getByRole("link", { name: "Activos" })).toHaveAttribute("aria-current", "page");
  await expect(projectRows(page).filter({ hasText: ACTIVE_PROJECT })).toHaveCount(1);
  await expect(projectRows(page).filter({ hasText: FINISHED_PROJECT })).toHaveCount(0);
  await expect(page.locator("thead")).toContainText("Costo del mes");
  await expect(projectRows(page).filter({ hasText: ACTIVE_PROJECT })).toContainText("Pendiente");
});

test("Finalizados lists finished jobs with their closing date and a year picker", async ({ page, context }) => {
  await signIn(context);
  await page.goto(basePath);
  await page.getByRole("link", { name: "Finalizados" }).click();

  await expect(page).toHaveURL(/estado=finalizados/);
  const row = projectRows(page).filter({ hasText: FINISHED_PROJECT });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("Finalizado");
  await expect(projectRows(page).filter({ hasText: ACTIVE_PROJECT })).toHaveCount(0);

  const yearPicker = page.getByLabel("Filtrar por año de cierre");
  await expect(yearPicker.locator("option", { hasText: "2026" })).toHaveCount(1);
  await yearPicker.selectOption("2026");
  await expect(page).toHaveURL(/anio=2026/);
  await expect(projectRows(page).filter({ hasText: FINISHED_PROJECT })).toHaveCount(1);
});

test("Todos shows active and finished jobs", async ({ page, context }) => {
  await signIn(context);
  await page.goto(`${basePath}?estado=todos`);

  await expect(projectRows(page).filter({ hasText: ACTIVE_PROJECT })).toHaveCount(1);
  await expect(projectRows(page).filter({ hasText: FINISHED_PROJECT })).toHaveCount(1);
});

test("document search finds receipts and manual sales, never credit notes nor annulled ones", async ({
  page,
  context,
}) => {
  const db = admin();
  const { data: job, error: jobError } = await db
    .from("projects")
    .select("id, client_id")
    .eq("company_id", DEMO_CHILE_COMPANY_ID)
    .eq("name", FINISHED_PROJECT)
    .single();
  if (jobError) throw jobError;

  const base = {
    company_id: DEMO_CHILE_COMPANY_ID,
    client_id: job.client_id,
    project_id: job.id,
    document_date: "2026-01-15",
    currency: "CLP",
    net_amount: 1000,
    tax_amount: 190,
    total_amount: 1190,
    voided: false,
  };
  const { data: docs, error: docsError } = await db
    .from("sales_documents")
    .insert([
      { ...base, document_type: "receipt", document_number: `${tag}-BOL` },
      { ...base, document_type: "manual", document_number: `${tag}-MAN` },
      { ...base, document_type: "credit_note", document_number: `${tag}-NCR` },
      { ...base, document_type: "receipt", document_number: `${tag}-BVOID`, voided: true },
      { ...base, document_type: "invoice", document_number: `${tag}-FANU` },
    ])
    .select("id, document_number");
  if (docsError) throw docsError;
  // A credit note that annuls the last invoice.
  const annulled = docs.find((doc) => doc.document_number === `${tag}-FANU`)!;
  const { data: creditNote, error: creditNoteError } = await db
    .from("sales_documents")
    .insert({ ...base, document_type: "credit_note", document_number: `${tag}-NCANU`, annuls_document_id: annulled.id })
    .select("id")
    .single();
  if (creditNoteError) throw creditNoteError;
  const { error: annulError } = await db
    .from("sales_documents")
    .update({ annulled_by_document_id: creditNote.id })
    .eq("id", annulled.id);
  if (annulError) throw annulError;

  await signIn(context);
  await page.goto(basePath);
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
  await signIn(context);

  for (const bad of ["7", "99999999999999999999"]) {
    await page.goto(`${basePath}?estado=finalizados&page=${bad}`);
    await expect(page, `page=${bad}`).not.toHaveURL(/page=/);
    await expect(projectRows(page).filter({ hasText: FINISHED_PROJECT }), `page=${bad}`).toHaveCount(1);
  }

  await page.goto(`${basePath}?q=servidor&page=3`);
  await expect(page).toHaveURL(/q=servidor/);
  await expect(page).not.toHaveURL(/page=/);
  await expect(projectRows(page).filter({ hasText: FINISHED_PROJECT })).toHaveCount(1);
});

test("search ignores accents, case and the open tab, and syncs ?q=", async ({ page, context }) => {
  await signIn(context);
  await page.goto(basePath);
  const search = page.getByLabel("Buscar proyectos");

  // Accented, upper case, from the Activos tab: finds the finished job.
  await search.fill("SERVIDÓR");
  await expect(page).toHaveURL(/q=SERVID%C3%93R/);
  const found = projectRows(page).filter({ hasText: FINISHED_PROJECT });
  await expect(found).toHaveCount(1);
  await expect(found).toContainText("Finalizado");
  await expect(page.getByText("1 resultado en todos los estados.")).toBeVisible();

  // Quote number and invoice number.
  await search.fill("dev-1002");
  await expect(page).toHaveURL(/q=dev-1002/);
  await expect(projectRows(page).filter({ hasText: FINISHED_PROJECT })).toHaveCount(1);
  await search.fill("F-1003");
  await expect(page).toHaveURL(/q=F-1003/);
  await expect(projectRows(page).filter({ hasText: FINISHED_PROJECT })).toHaveCount(1);

  // Client name without accents or capitals matches both jobs.
  await search.fill("cliente demo chile");
  await expect(page.getByText("2 resultados en todos los estados.")).toBeVisible();

  // Loading the URL directly restores the box.
  await page.goto(`${basePath}?q=red%20de%20oficina`);
  await expect(search).toHaveValue("red de oficina");
  await expect(projectRows(page).filter({ hasText: ACTIVE_PROJECT })).toHaveCount(1);

  // A tab link leaves the search.
  await page.getByRole("link", { name: "Todos" }).click();
  await expect(page).not.toHaveURL(/q=/);
  await expect(search).toHaveValue("");
});
