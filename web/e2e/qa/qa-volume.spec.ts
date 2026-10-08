/**
 * Volume QA of the projects list (search, tabs + closed_at) and the job
 * detail (checklist + notes) over the ~300 projects of seed-volume.mjs.
 * Opt-in (QA_VOLUME=1, see README.md): playwright.config.ts leaves e2e/qa
 * out of `npm run test:e2e` otherwise. inma-erp-dev only.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { loadEnvConfig } from "@next/env";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

loadEnvConfig(path.resolve(__dirname, "..", ".."));

const DEV_REF = "sczgankronafrxybpvnh";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
if (process.env.QA_VOLUME !== "1") throw new Error("Volume QA is opt-in: set QA_VOLUME=1.");
if (URL.canParse(url) ? new URL(url).host !== `${DEV_REF}.supabase.co` : true) {
  throw new Error(`Aborted: NEXT_PUBLIC_SUPABASE_URL is not inma-erp-dev (${DEV_REF}).`);
}

type User = { id: string; email: string; password: string };
const statePath = process.env.QA_STATE || path.join(__dirname, ".qa-state.json");
const state = JSON.parse(readFileSync(statePath, "utf8")) as {
  tag: string;
  companyId: string;
  otherCompanyId: string;
  otherProjectId: string;
  owner: User;
  second: User;
  outsider: User;
  projects: Record<string, string>;
};
const MOBILE = process.env.QA_MOBILE === "1";
const basePath = `/companies/${state.companyId}/projects`;
const admin = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

test.describe.configure({ mode: "serial" });
if (MOBILE) test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

const cookieCache = new Map<string, { name: string; value: string }[]>();
async function signIn(context: BrowserContext, user: User) {
  if (!cookieCache.has(user.email)) {
    const jar = new Map<string, string>();
    const ssr = createServerClient(url, anonKey, {
      cookies: {
        getAll: () => [...jar].map(([name, value]) => ({ name, value })),
        setAll: (toSet) => toSet.forEach(({ name, value }) => jar.set(name, value)),
      },
    });
    const { error } = await ssr.auth.signInWithPassword({ email: user.email, password: user.password });
    if (error) throw error;
    cookieCache.set(user.email, [...jar].map(([name, value]) => ({ name, value })));
  }
  await context.clearCookies();
  await context.addCookies(
    cookieCache.get(user.email)!.map((c) => ({ ...c, domain: "localhost", path: "/", sameSite: "Lax" as const })),
  );
}

async function userClient(user: User): Promise<SupabaseClient> {
  const client = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { error } = await client.auth.signInWithPassword({ email: user.email, password: user.password });
  if (error) throw error;
  return client;
}

const consoleErrors: string[] = [];
test.beforeEach(async ({ page }) => {
  page.on("pageerror", (error) => consoleErrors.push(`pageerror ${page.url()}: ${error.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(`console ${page.url()}: ${msg.text()}`);
  });
});
test.afterAll(() => {
  console.log(`CONSOLE ERRORS (${consoleErrors.length}):\n${consoleErrors.slice(0, 30).join("\n")}`);
});

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, "page scrolls horizontally").toBeLessThanOrEqual(1);
}

// ---------------------------------------------------------------------
// Search oracle: the same matching rules as list_projects, in JS.
// ---------------------------------------------------------------------
const normalize = (value: string) => value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
let haystacks: { id: string; fields: string[] }[] = [];

test.beforeAll(async () => {
  // Searchable documents: invoices, receipts and manual sales, neither
  // voided nor annulled by a credit note.
  const [{ data: projects }, { data: aliases }, { data: quotes }, { data: invoices }] = await Promise.all([
    admin.from("projects").select("id, name, client_id, clients(name)").eq("company_id", state.companyId),
    admin.from("client_aliases").select("client_id, external_name").eq("company_id", state.companyId),
    admin.from("project_quotes").select("project_id, quote_number").eq("company_id", state.companyId),
    admin
      .from("sales_documents")
      .select("project_id, document_number")
      .eq("company_id", state.companyId)
      .in("document_type", ["invoice", "receipt", "manual"])
      .eq("voided", false)
      .is("annulled_by_document_id", null),
  ]);
  haystacks = (projects ?? []).map((p) => {
    const client = (Array.isArray(p.clients) ? p.clients[0] : p.clients) as { name: string } | null;
    return {
      id: p.id,
      fields: [
        p.name,
        client?.name ?? "",
        ...(aliases ?? []).filter((a) => a.client_id === p.client_id).map((a) => a.external_name),
        ...(quotes ?? []).filter((q) => q.project_id === p.id).map((q) => q.quote_number),
        ...(invoices ?? []).filter((d) => d.project_id === p.id).map((d) => d.document_number ?? ""),
      ],
    };
  });
});

function expectedMatches(query: string): number {
  const needle = normalize(query.trim().replace(/\s+/g, " "));
  return haystacks.filter((h) => h.fields.some((f) => normalize(f).includes(needle))).length;
}

async function resultCount(page: Page): Promise<number> {
  const text = await page.getByText(/resultados? en todos los estados\./).innerText();
  return Number(text.split(" ")[0]);
}

test("search: accents, case, ñ, partials, numbers, special characters", async ({ page, context }) => {
  await signIn(context, state.owner);
  await page.goto(basePath);
  if (MOBILE) await noHorizontalScroll(page);
  const search = page.getByLabel("Buscar proyectos");

  const queries = [
    "PEÑALOLÉN",
    "penalolen",
    "Peñalolen",
    "ñandú",
    "NANDU",
    "san jose",
    "Agrícola San José",
    "ébano",
    "pingüino",
    "PINGUINO FRIO", // alias
    "opticas nunoa", // alias with accents removed
    "cámaras",
    "  instalación    cámaras  ", // extra spaces collapse
    `${state.tag}-Q1004`,
    "Q100",
    `${state.tag}-F2020`,
    `${state.tag.toUpperCase()}-f2020`,
    "F202",
    `${state.tag}-B2032`, // receipt
    "B20",
    `${state.tag}-M2004`, // manual sale
    "-m200",
    "%",
    "50%",
    "_",
    "under_score",
    "'",
    "o'brien",
    '"',
    'comillas"',
    "\\",
  ];
  const report: string[] = [];
  for (const query of queries) {
    await search.fill(query);
    const expected = expectedMatches(query);
    if (expected === 0) {
      await expect(page.getByText("0 resultados en todos los estados.")).toBeVisible();
    } else {
      await expect
        .poll(async () => (await page.getByText(/resultados? en todos los estados\./).count()) > 0 ? resultCount(page) : -1, {
          message: `query ${JSON.stringify(query)}`,
        })
        .toBe(expected);
    }
    report.push(`${JSON.stringify(query)} -> ${expected}`);
  }
  console.log(report.join("\n"));

  // Credit notes, voided documents and an invoice annulled by a credit
  // note are not searchable.
  for (const number of ["FANULADA", "B2012", "NC2008", "FNCANU", "NCANU"]) {
    await search.fill(`${state.tag}-${number}`);
    await expect(page.getByText("0 resultados en todos los estados."), number).toBeVisible();
  }
  await expect(page.getByText(/No hay proyectos que coincidan/)).toBeVisible();

  // Blank and whitespace-only: back to the tab view.
  await search.fill("   ");
  await expect(page).not.toHaveURL(/q=/);
  await expect(page.getByText(/resultados? en todos los estados/)).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Activos" })).toHaveAttribute("aria-current", "page");

  // The other company's identical client name never leaks.
  await search.fill("Proyecto secreto");
  await expect(page.getByText("0 resultados en todos los estados.")).toBeVisible();
});

test("search: fast typing never leaves an old result or eats characters", async ({ page, context }) => {
  await signIn(context, state.owner);
  await page.goto(basePath);
  const search = page.getByLabel("Buscar proyectos");
  await search.click();

  // Fast, then with pauses around the 300 ms debounce, so intermediate
  // searches are in flight while typing goes on.
  const target = "instalacion camaras penalolen";
  for (const [index, char] of [...target].entries()) {
    await page.keyboard.type(char);
    await page.waitForTimeout(index % 6 === 5 ? 340 : 40);
  }
  await expect(search).toHaveValue(target);
  await expect(page).toHaveURL(/q=instalacion\+camaras\+penalolen/);
  await expect.poll(() => resultCount(page)).toBe(expectedMatches(target));
  await page.waitForTimeout(1200);
  await expect(search).toHaveValue(target);

  // Delete with backspaces quickly, then type something else.
  for (let i = 0; i < target.length; i += 1) {
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(i % 7 === 6 ? 330 : 25);
  }
  await page.keyboard.type("ébano", { delay: 60 });
  await expect(search).toHaveValue("ébano");
  await expect.poll(() => resultCount(page)).toBe(expectedMatches("ébano"));
  await page.waitForTimeout(1200);
  await expect(search).toHaveValue("ébano");
  const rows = page.locator("tbody tr");
  for (const text of await rows.allInnerTexts()) expect(normalize(text)).toContain("ebano");
});

test("tabs, year, page and q in the URL: reload, back/forward, new tab, invalid pages", async ({ page, context }) => {
  await signIn(context, state.owner);
  const { count: finishedCount } = await admin
    .from("projects")
    .select("id", { count: "exact", head: true })
    .eq("company_id", state.companyId)
    .in("status", ["finalizado", "cerrado", "cancelado"]);
  const { count: activeCount } = await admin
    .from("projects")
    .select("id", { count: "exact", head: true })
    .eq("company_id", state.companyId)
    .not("status", "in", "(finalizado,cerrado,cancelado)");
  const lastPage = Math.ceil((finishedCount ?? 0) / 25);

  await page.goto(basePath);
  await expect(page.locator("tbody tr")).toHaveCount(activeCount ?? 0);

  await page.getByRole("link", { name: "Finalizados" }).click();
  await expect(page).toHaveURL(/estado=finalizados/);
  await expect(page.getByText(`de ${finishedCount}`)).toBeVisible();

  // Closing dates go newest first within and across pages.
  const dates: string[] = [];
  for (let p = 1; p <= lastPage; p += 1) {
    await page.goto(`${basePath}?estado=finalizados${p > 1 ? `&page=${p}` : ""}`);
    await expect(page.getByText(`Página ${p} de ${lastPage}`)).toBeVisible();
    const cells = await page.locator("tbody tr td:nth-child(3)").allInnerTexts();
    dates.push(...cells.map((c) => c.trim()));
  }
  expect(dates).toHaveLength(finishedCount ?? 0);
  const iso = dates.map((d) => d.split("/").reverse().join("-"));
  expect([...iso].sort().reverse()).toEqual(iso);

  // Year picker + page + reload + back/forward.
  await page.goto(`${basePath}?estado=finalizados`);
  await page.getByLabel("Filtrar por año de cierre").selectOption("2025");
  await expect(page).toHaveURL(/anio=2025/);
  const rows2025 = await page.locator("tbody tr td:nth-child(3)").allInnerTexts();
  for (const d of rows2025) expect(d.trim()).toMatch(/\/2025$/);
  // The Santiago year boundary: closed 2026-01-01 02:30 UTC = 31/12/2025.
  await page.goto(`${basePath}?estado=finalizados&anio=2025`);
  const edge = page.locator("tbody tr").filter({ hasText: "QA cierre fin de año" });
  await expect(edge).toHaveCount(1);
  await expect(edge).toContainText("31/12/2025");

  if (await page.getByRole("link", { name: "Siguiente" }).count()) {
    await page.getByRole("link", { name: "Siguiente" }).click();
    await expect(page).toHaveURL(/anio=2025.*page=2|page=2.*anio=2025/);
    // The URL changes while loading.tsx's skeleton is still on screen.
    await expect(page.getByText(/Página 2 de/)).toBeVisible();
    // textContent, not innerText: innerText depends on whether CSS is applied yet.
    const rowsOf = async (p: Page) =>
      (await p.locator("tbody tr").allTextContents()).map((t) => t.replace(/\s+/g, ""));
    const page2 = await rowsOf(page);
    await page.reload();
    expect(await rowsOf(page)).toEqual(page2);
    await page.goBack();
    await expect(page).not.toHaveURL(/page=2/);
    await page.goForward();
    await expect(page).toHaveURL(/page=2/);
    const settled = Date.now();
    await expect.poll(() => rowsOf(page), { timeout: 10_000 }).toEqual(page2);
    console.log(`forward settled after ${Date.now() - settled} ms`);
    // Same URL in another tab.
    const other = await context.newPage();
    await other.goto(page.url());
    expect(await rowsOf(other)).toEqual(page2);
    await other.close();
  }

  // q + estado: search keeps the tab for when it is cleared.
  await page.goto(`${basePath}?estado=finalizados&q=ebano`);
  await expect(page.getByLabel("Buscar proyectos")).toHaveValue("ebano");
  await expect(page.getByRole("link", { name: "Finalizados" })).not.toHaveAttribute("aria-current", "page");
  await page.getByLabel("Buscar proyectos").fill("");
  await expect(page).toHaveURL(/estado=finalizados/);
  await expect(page).not.toHaveURL(/q=/);
  await expect(page.getByRole("link", { name: "Finalizados" })).toHaveAttribute("aria-current", "page");

  // The search box replaces the history entry (no entry per keystroke), so
  // the flow that matters is: search -> open a job -> back to the results.
  await page.getByLabel("Buscar proyectos").fill("ebano");
  await expect(page).toHaveURL(/q=ebano/);
  const firstResult = page.locator("tbody tr").first().getByRole("link").first();
  const firstName = await firstResult.innerText();
  await firstResult.click();
  await expect(page).toHaveURL(/projects\/[0-9a-f-]{36}$/);
  await page.goBack();
  await expect(page).toHaveURL(/q=ebano/);
  await expect(page.getByLabel("Buscar proyectos")).toHaveValue("ebano");
  await expect(page.locator("tbody tr").first()).toContainText(firstName);

  // Pages: last, past the end, invalid.
  await page.goto(`${basePath}?estado=finalizados&page=${lastPage}`);
  await expect(page.getByText(`Página ${lastPage} de ${lastPage}`)).toBeVisible();
  await expect(page.getByRole("link", { name: "Siguiente" })).toHaveCount(0);

  for (const bad of ["999", "abc", "0", "-3", "1.5", "99999999999999999999"]) {
    await page.goto(`${basePath}?estado=finalizados&page=${bad}`);
    // (Next's route announcer is an empty role=alert.)
    await expect(page.getByRole("alert").filter({ hasText: /\S/ }), `page=${bad}`).toHaveCount(0);
    await expect(page.locator("tbody tr").first(), `page=${bad}`).not.toContainText("No hay proyectos");
    await expect(page.getByText(/Página \d+ de/), `page=${bad}`).toBeVisible();
  }
  await page.goto(`${basePath}?estado=finalizados&page=999`);
  await expect(page.getByText(`Página ${lastPage} de ${lastPage}`)).toBeVisible();
  await page.goto(`${basePath}?q=ebano&page=50`);
  await expect(page.locator("tbody tr").first()).not.toContainText("No hay proyectos");
  await page.goto(`${basePath}?estado=raro&anio=abcd`);
  await expect(page.getByRole("link", { name: "Activos" })).toHaveAttribute("aria-current", "page");
  if (MOBILE) await noHorizontalScroll(page);
});

test("closed_at: active -> finalizado -> cerrado -> active -> finalizado", async ({ page, context }) => {
  await signIn(context, state.owner);
  const id = state.projects.transitions;
  const closedAt = async () =>
    (await admin.from("projects").select("closed_at").eq("id", id).single()).data?.closed_at as string | null;

  async function setStatus(status: string) {
    await page.goto(`${basePath}/${id}/edit`);
    await page.getByLabel("Estado").selectOption(status);
    await page.getByRole("button", { name: "Guardar cambios" }).click();
    await expect(page).toHaveURL(new RegExp(`${basePath}$`));
  }

  expect(await closedAt()).toBeNull();
  await setStatus("finalizado");
  const first = await closedAt();
  expect(first).not.toBeNull();
  expect(Math.abs(Date.parse(first!) - Date.now())).toBeLessThan(5 * 60_000);

  await page.goto(`${basePath}?estado=finalizados`);
  await expect(page.locator("tbody tr").first()).toContainText("QA transiciones de estado");
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Santiago" }).format(new Date());
  await expect(page.locator("tbody tr").first()).toContainText(today.split("-").reverse().join("/"));

  await page.waitForTimeout(1500);
  await setStatus("cerrado");
  expect(await closedAt()).toBe(first);

  await setStatus("en_ejecucion");
  expect(await closedAt()).toBeNull();
  await page.goto(`${basePath}?estado=finalizados`);
  await expect(page.locator("tbody tr").filter({ hasText: "QA transiciones de estado" })).toHaveCount(0);

  await page.waitForTimeout(1500);
  await setStatus("finalizado");
  const second = await closedAt();
  expect(Date.parse(second!)).toBeGreaterThan(Date.parse(first!));

  await page.goto(`${basePath}/${id}`);
  const events = page.locator('li[data-kind="status_change"]');
  await expect(events).toHaveCount(4);
  await expect(events.nth(0)).toContainText("En ejecución → Finalizado");
  await expect(events.nth(1)).toContainText("Cerrado → En ejecución");
  await expect(events.nth(2)).toContainText("Finalizado → Cerrado");
  await expect(events.nth(3)).toContainText("En ejecución → Finalizado");
  await expect(events.getByRole("button")).toHaveCount(0);

  // Same status saved again (only another field changes): no new event.
  await page.goto(`${basePath}/${id}/edit`);
  await page.getByLabel("Responsable").fill("Alguien");
  await page.getByRole("button", { name: "Guardar cambios" }).click();
  await expect(page).toHaveURL(new RegExp(`${basePath}$`));
  await page.goto(`${basePath}/${id}`);
  await expect(page.locator('li[data-kind="status_change"]')).toHaveCount(4);
});

test("checklist: 0, 1 and 35 items, extremes, fast toggles, long text, list counter", async ({ page, context }) => {
  await signIn(context, state.owner);
  const progress = page.getByTestId("checklist-progress");

  await page.goto(`${basePath}/${state.projects.checklistEmpty}`);
  await expect(page.getByText("Todavía no hay ítems.")).toBeVisible();
  await expect(progress).toHaveCount(0);
  const newItem = page.getByLabel("Nuevo ítem del checklist");
  await newItem.press("Enter");
  await newItem.fill("   ");
  await newItem.press("Enter");
  await page.waitForTimeout(600);
  await expect(page.getByText("Todavía no hay ítems.")).toBeVisible();

  await page.goto(`${basePath}/${state.projects.checklistOne}`);
  await expect(progress).toHaveText("0/1");
  await expect(page.getByRole("button", { name: /^Subir/ })).toBeDisabled();
  await expect(page.getByRole("button", { name: /^Bajar/ })).toBeDisabled();

  const big = state.projects.checklistBig;
  await page.goto(`${basePath}/${big}`);
  await expect(progress).toHaveText("12/35");
  if (MOBILE) await noHorizontalScroll(page);
  const itemsLocator = page.locator("li").filter({ has: page.getByRole("checkbox") });
  await expect(itemsLocator).toHaveCount(35);
  // Long text wraps inside the card.
  const card = page.locator(".surface-card").filter({ hasText: "Checklist" });
  const overflow = await card.evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);

  // Extremes.
  await expect(itemsLocator.first().getByRole("button", { name: /^Subir/ })).toBeDisabled();
  await expect(itemsLocator.last().getByRole("button", { name: /^Bajar/ })).toBeDisabled();
  const firstText = (await itemsLocator.first().innerText()).trim();
  await itemsLocator.first().getByRole("button", { name: /^Bajar/ }).click();
  await expect(itemsLocator.nth(1)).toContainText(firstText);
  const lastText = (await itemsLocator.last().innerText()).trim();
  await itemsLocator.last().getByRole("button", { name: /^Subir/ }).click();
  await expect(itemsLocator.nth(33)).toContainText(lastText);
  await itemsLocator.nth(33).getByRole("button", { name: /^Bajar/ }).click();
  await expect(itemsLocator.last()).toContainText(lastText);

  // Fast toggles on one item: the end state matches the database.
  const box = itemsLocator.nth(1).getByRole("checkbox");
  for (let i = 0; i < 7; i += 1) await box.click({ force: true, timeout: 2000 }).catch(() => {});
  await page.waitForTimeout(2500);
  const shown = await box.isChecked();
  const { data: dbItems } = await admin
    .from("project_checklist_items")
    .select("text, is_done, done_at, position")
    .eq("project_id", big)
    .order("position");
  const dbItem = dbItems!.find((it) => it.text === firstText.trim());
  expect(dbItem?.is_done).toBe(shown);
  expect(dbItem?.done_at == null).toBe(!shown);
  const doneInDb = dbItems!.filter((it) => it.is_done).length;
  await expect(progress).toHaveText(`${doneInDb}/35`);
  await page.reload();
  await expect(progress).toHaveText(`${doneInDb}/35`);
  // Positions stay unique.
  expect(new Set(dbItems!.map((it) => it.position)).size).toBe(35);

  // Edit: Enter saves, Escape cancels, blur saves.
  await itemsLocator.nth(2).getByRole("button", { name: /Tarea|Ítem/ }).first().click();
  await page.getByLabel("Texto del ítem").fill("Editado con Enter ✅");
  await page.getByLabel("Texto del ítem").press("Enter");
  await expect(itemsLocator.nth(2)).toContainText("Editado con Enter ✅");
  await itemsLocator.nth(3).locator("button").first().click();
  await page.getByLabel("Texto del ítem").fill("NO DEBE GUARDARSE");
  await page.getByLabel("Texto del ítem").press("Escape");
  await page.waitForTimeout(800);
  await expect(page.getByText("NO DEBE GUARDARSE")).toHaveCount(0);
  await itemsLocator.nth(4).locator("button").first().click();
  await page.getByLabel("Texto del ítem").fill("Guardado al salir");
  await page.getByLabel("Nuevo ítem del checklist").click();
  await expect(itemsLocator.nth(4)).toContainText("Guardado al salir");
  // Emptying the text is refused.
  await itemsLocator.nth(4).locator("button").first().click();
  await page.getByLabel("Texto del ítem").fill("");
  await page.getByLabel("Texto del ítem").press("Enter");
  await page.reload();
  await expect(itemsLocator.nth(4)).toContainText("Guardado al salir");

  // Very long text without spaces, then delete it.
  const long = "palabra".repeat(80);
  await newItem.fill(long);
  await newItem.press("Enter");
  await expect(progress).toHaveText(`${doneInDb}/36`);
  expect(await card.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  if (MOBILE) await noHorizontalScroll(page);
  await page.getByRole("button", { name: `Borrar “${long}”` }).click();
  await expect(progress).toHaveText(`${doneInDb}/35`);

  // The list counter matches.
  await page.goto(`${basePath}?q=${encodeURIComponent("QA checklist")}`);
  await expect(page.locator("tbody tr").filter({ hasText: "QA checklist grande" }).getByTestId("checklist-progress")).toHaveText(
    `☑ ${doneInDb}/35`,
  );
  await expect(page.locator("tbody tr").filter({ hasText: "QA checklist uno" }).getByTestId("checklist-progress")).toHaveText("☑ 0/1");
  await expect(page.locator("tbody tr").filter({ hasText: "QA checklist vacío" }).getByTestId("checklist-progress")).toHaveCount(0);
});

test("notes: shortcut, edit, delete, long text, links, no HTML injection, author rule", async ({ page, context }) => {
  await signIn(context, state.owner);
  const id = state.projects.notes;
  await page.goto(`${basePath}/${id}`);
  const notes = page.locator('li[data-kind="note"]');
  await expect(notes).toHaveCount(2);

  // Single member: no author name.
  await expect(page.getByText("Dueña QA Ñúñez")).toHaveCount(0);

  // Long seeded note: line breaks, links, emojis.
  const longNote = notes.filter({ hasText: "Visita técnica" });
  const body = await longNote.locator("p").innerText();
  expect(body).toContain("Pendientes:\n- Comprar 3 cámaras 📷");
  await expect(longNote.getByRole("link", { name: "https://example.com/planos/peñalolén?v=1&x=2" })).toHaveAttribute(
    "href",
    "https://example.com/planos/peñalolén?v=1&x=2",
  );
  await expect(longNote.getByRole("link", { name: "www.inma.cl/soporte" })).toHaveAttribute("href", "https://www.inma.cl/soporte");
  await expect(longNote.getByRole("link", { name: "www.inma.cl/soporte" })).toHaveAttribute("target", "_blank");
  if (MOBILE) await noHorizontalScroll(page);

  const box = page.getByLabel("Nueva nota");
  await box.fill("Con Meta+Enter");
  await box.press("Meta+Enter");
  await expect(box).toHaveValue("");
  await expect(notes.first()).toContainText("Con Meta+Enter");
  // Plain Enter is a line break, not a submit.
  await box.fill("línea 1");
  await box.press("Enter");
  await box.type("línea 2");
  await expect(box).toHaveValue("línea 1\nlínea 2");
  await box.press("Control+Enter");
  await expect(notes.first().locator("p")).toHaveText("línea 1\nlínea 2");

  // HTML / script stays text.
  const evil = `<img src=x onerror="window.__xss=1"><script>window.__xss=2</script><b>negrita</b> javascript:alert(1)`;
  await box.fill(evil);
  await box.press("Control+Enter");
  await expect(notes.first()).toContainText("<b>negrita</b>");
  expect(await notes.first().locator("b, img, script").count()).toBe(0);
  expect(await notes.first().getByRole("link").count()).toBe(0);
  await page.reload();
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();

  // Edit: shows (editado); Escape cancels.
  const target = notes.filter({ hasText: "Con Meta+Enter" });
  await target.getByRole("button", { name: "Editar" }).click();
  await page.getByLabel("Editar nota").fill("Con Meta+Enter (corregida)\nhttps://inma.cl");
  await page.getByLabel("Editar nota").press("Control+Enter");
  const edited = notes.filter({ hasText: "corregida" });
  await expect(edited).toContainText("(editado)");
  await expect(edited.getByRole("link", { name: "https://inma.cl" })).toBeVisible();
  await edited.getByRole("button", { name: "Editar" }).click();
  await page.getByLabel("Editar nota").fill("no guardar");
  await page.getByLabel("Editar nota").press("Escape");
  await expect(page.getByText("no guardar")).toHaveCount(0);

  // Delete: dismiss keeps it, accept removes it.
  page.once("dialog", (dialog) => dialog.dismiss());
  await edited.getByRole("button", { name: "Borrar" }).click();
  await page.waitForTimeout(800);
  await expect(edited).toHaveCount(1);
  page.once("dialog", (dialog) => dialog.accept());
  await edited.getByRole("button", { name: "Borrar" }).click();
  await expect(edited).toHaveCount(0);

  // A second member: names appear; they cannot edit the owner's notes.
  await admin.from("company_memberships").insert({ user_id: state.second.id, company_id: state.companyId, role: "member" });
  await page.reload();
  await expect(notes.first()).toContainText("Dueña QA Ñúñez");
  await signIn(context, state.second);
  await page.goto(`${basePath}/${id}`);
  await expect(notes.first()).toContainText("Dueña QA Ñúñez");
  await expect(page.locator('li[data-kind="note"]').getByRole("button", { name: "Editar" })).toHaveCount(0);
  await page.getByLabel("Nueva nota").fill("Nota del segundo miembro");
  await page.getByLabel("Nueva nota").press("Control+Enter");
  await expect(notes.first()).toContainText("Segundo Miembro QA");
  await expect(notes.first().getByRole("button", { name: "Editar" })).toBeVisible();

  const second = await userClient(state.second);
  const { data: ownerNotes } = await admin.from("project_notes").select("id").eq("project_id", id).eq("author_id", state.owner.id);
  const hijack = await second.from("project_notes").update({ body: "hackeado" }).eq("id", ownerNotes![0].id).select("id");
  expect(hijack.data ?? []).toEqual([]);
  const steal = await second.from("project_notes").delete().eq("id", ownerNotes![0].id).select("id");
  expect(steal.data ?? []).toEqual([]);
  const forge = await second
    .from("project_notes")
    .insert({ company_id: state.companyId, project_id: id, kind: "note", body: "suplantado", author_id: state.owner.id });
  expect(forge.error).not.toBeNull();
  const fakeEvent = await second
    .from("project_notes")
    .insert({ company_id: state.companyId, project_id: id, kind: "status_change", body: "a -> b", author_id: null });
  expect(fakeEvent.error).not.toBeNull();
  // Status events cannot be edited even by a member.
  const { data: anyEvent } = await admin.from("project_notes").select("id").eq("kind", "status_change").eq("company_id", state.companyId).limit(1);
  if (anyEvent?.length) {
    const editEvent = await second.from("project_notes").update({ body: "x" }).eq("id", anyEvent[0].id).select("id");
    expect(editEvent.data ?? []).toEqual([]);
  }
  // Moving a note to another kind/author is refused even for its author.
  const { data: mine } = await second.from("project_notes").select("id").eq("author_id", state.second.id).limit(1);
  const kindChange = await second.from("project_notes").update({ kind: "status_change", author_id: null }).eq("id", mine![0].id).select("id");
  expect(kindChange.error !== null || (kindChange.data ?? []).length === 0).toBe(true);

  await admin.from("company_memberships").delete().eq("user_id", state.second.id).eq("company_id", state.companyId);
  // Back to one member: names hidden again; the ex-member's note keeps no name.
  await signIn(context, state.owner);
  await page.goto(`${basePath}/${id}`);
  await expect(page.getByText("Segundo Miembro QA")).toHaveCount(0);
  await expect(page.getByText("Dueña QA Ñúñez")).toHaveCount(0);
});

test("security: another company's member and the anon key", async ({ page, context }) => {
  const outsider = await userClient(state.outsider);
  const anon = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: someItem } = await admin
    .from("project_checklist_items")
    .select("id, is_done, position")
    .eq("company_id", state.companyId)
    .limit(1)
    .single();
  const { data: someNote } = await admin.from("project_notes").select("id").eq("company_id", state.companyId).limit(1).single();

  for (const table of ["project_checklist_items", "project_notes", "projects", "project_quotes", "client_aliases"]) {
    const { data, error } = await outsider.from(table).select("id").eq("company_id", state.companyId);
    expect(error, table).toBeNull();
    expect(data, table).toEqual([]);
    const anonRead = await anon.from(table).select("id").eq("company_id", state.companyId);
    expect(anonRead.data ?? [], `anon ${table}`).toEqual([]);
  }
  const rpcs: [string, Record<string, unknown>][] = [
    ["list_projects", { p_company_id: state.companyId, p_scope: "todos" }],
    ["list_projects", { p_company_id: state.companyId, p_query: "a" }],
    ["project_closed_years", { p_company_id: state.companyId }],
    ["project_checklist_progress", { p_company_id: state.companyId, p_project_ids: [state.projects.checklistBig] }],
    ["company_member_names", { p_company_id: state.companyId }],
  ];
  for (const [fn, args] of rpcs) {
    const res = await outsider.rpc(fn, args);
    expect(res.error, fn).toBeNull();
    expect(res.data ?? [], fn).toEqual([]);
    const anonRes = await anon.rpc(fn, args);
    expect(anonRes.error, `anon ${fn}`).not.toBeNull();
    console.log(`anon ${fn}: ${anonRes.error?.code} ${anonRes.error?.message}`);
  }
  const anonMove = await anon.rpc("move_project_checklist_item", { p_item_id: someItem!.id, p_direction: 1 });
  expect(anonMove.error).not.toBeNull();

  const move = await outsider.rpc("move_project_checklist_item", { p_item_id: someItem!.id, p_direction: 1 });
  expect(move.data === false || move.error !== null).toBe(true);
  const upd = await outsider.from("project_checklist_items").update({ is_done: !someItem!.is_done }).eq("id", someItem!.id).select("id");
  expect(upd.data ?? []).toEqual([]);
  const del = await outsider.from("project_checklist_items").delete().eq("id", someItem!.id).select("id");
  expect(del.data ?? []).toEqual([]);
  const delNote = await outsider.from("project_notes").delete().eq("id", someNote!.id).select("id");
  expect(delNote.data ?? []).toEqual([]);
  const ins1 = await outsider
    .from("project_checklist_items")
    .insert({ company_id: state.companyId, project_id: state.projects.checklistBig, text: "intruso" });
  expect(ins1.error).not.toBeNull();
  // Own company id, foreign project: the trigger refuses it.
  const ins2 = await outsider
    .from("project_checklist_items")
    .insert({ company_id: state.otherCompanyId, project_id: state.projects.checklistBig, text: "intruso" });
  expect(ins2.error).not.toBeNull();
  const ins3 = await outsider
    .from("project_notes")
    .insert({ company_id: state.otherCompanyId, project_id: state.projects.notes, body: "intruso", author_id: state.outsider.id });
  expect(ins3.error).not.toBeNull();
  const statusChange = await outsider.from("projects").update({ status: "cancelado" }).eq("id", state.projects.notes).select("id");
  expect(statusChange.data ?? []).toEqual([]);
  // Nothing changed.
  const { data: after } = await admin.from("project_checklist_items").select("is_done, position").eq("id", someItem!.id).single();
  expect(after).toEqual({ is_done: someItem!.is_done, position: someItem!.position });

  // UI.
  await signIn(context, state.outsider);
  for (const target of [basePath, `${basePath}/${state.projects.notes}`, `${basePath}?q=pe`, `${basePath}/${state.projects.notes}/edit`]) {
    await page.goto(target);
    await expect(page, target).not.toHaveURL(new RegExp(state.companyId));
    await expect(page.getByText("Visita técnica")).toHaveCount(0);
  }
  // Their own company, the QA project id in the URL: not found.
  await page.goto(`/companies/${state.otherCompanyId}/projects/${state.projects.notes}`);
  await expect(page.getByText("Visita técnica")).toHaveCount(0);
});

test("existing screens still work: dashboard, month costs, confirm zero, recurring services, edit", async ({ page, context }) => {
  await signIn(context, state.owner);
  const timings: string[] = [];
  async function timed(target: string) {
    const start = Date.now();
    const response = await page.goto(target);
    await page.waitForLoadState("networkidle");
    timings.push(`${target.replace(`/companies/${state.companyId}`, "")}: ${Date.now() - start} ms (HTTP ${response?.status()})`);
    expect(response?.status(), target).toBeLessThan(400);
    await expect(page.getByText(/Algo salió mal|Application error|Unhandled Runtime Error/)).toHaveCount(0);
  }
  await timed(`/companies/${state.companyId}`);
  await timed(basePath);
  await timed(`${basePath}?estado=finalizados`);
  await timed(`${basePath}?estado=todos&page=12`);
  await timed(`${basePath}?q=pe%C3%B1alolen`);
  await timed(`${basePath}/${state.projects.checklistBig}`);
  await timed(`${basePath}/board`);
  await timed(`/companies/${state.companyId}/recurring-services`);
  await timed(`/companies/${state.companyId}/costs`);
  console.log(`PAGE LOAD (${MOBILE ? "mobile" : "desktop"}):\n${timings.join("\n")}`);

  // Confirm zero and undo it.
  await page.goto(basePath);
  await expect(page.locator("thead")).toContainText("Costo del mes");
  const row = page.locator("tbody tr").filter({ hasText: "QA checklist uno" });
  await expect(row).toContainText("Pendiente");
  await row.getByRole("button", { name: "Confirmar cero" }).click();
  await expect(row).toContainText("Cero confirmado");
  await row.getByRole("button", { name: "Quitar confirmación" }).click();
  await expect(row).toContainText("Pendiente");

  // Project edit still saves.
  await page.goto(`${basePath}/${state.projects.checklistOne}/edit`);
  await page.getByLabel("Nombre").fill("QA checklist uno (editado)");
  await page.getByRole("button", { name: "Guardar cambios" }).click();
  await expect(page).toHaveURL(new RegExp(`${basePath}$`));
  await expect(page.locator("tbody tr").filter({ hasText: "QA checklist uno (editado)" })).toHaveCount(1);
  await page.goto(`${basePath}/${state.projects.checklistOne}/edit`);
  await page.getByLabel("Nombre").fill("QA checklist uno");
  await page.getByRole("button", { name: "Guardar cambios" }).click();
  await expect(page).toHaveURL(new RegExp(`${basePath}$`));
  if (MOBILE) await noHorizontalScroll(page);
});

// Report only (no threshold: it depends on the network to Supabase). Run
// alone with -g "load timings" to compare before/after a change.
test("load timings: server response and full load per page", async ({ page, context }) => {
  await signIn(context, state.owner);
  const company = `/companies/${state.companyId}`;
  const targets: [string, string][] = [
    ["dashboard", company],
    ["Activos", basePath],
    ["Finalizados", `${basePath}?estado=finalizados`],
    ["Todos, last page", `${basePath}?estado=todos&page=12`],
    ["search", `${basePath}?q=pe%C3%B1alolen`],
    ["detail (35 items)", `${basePath}/${state.projects.checklistBig}`],
    ["detail (notes)", `${basePath}/${state.projects.notes}`],
  ];
  const lines: string[] = [];
  for (const [label, target] of targets) {
    const ttfb: number[] = [];
    const load: number[] = [];
    // The first visit warms the server up and is left out.
    for (let run = 0; run < 6; run += 1) {
      await page.goto(target);
      const timing = await page.evaluate(() => {
        const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming;
        return { ttfb: nav.responseStart - nav.requestStart, load: nav.loadEventEnd - nav.startTime };
      });
      if (run > 0) {
        ttfb.push(timing.ttfb);
        load.push(timing.load);
      }
    }
    const median = (values: number[]) => Math.round([...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]);
    lines.push(`${label.padEnd(18)} ttfb ${String(median(ttfb)).padStart(4)} ms   load ${String(median(load)).padStart(4)} ms`);
  }
  console.log(`LOAD TIMINGS (median of 5, ${MOBILE ? "mobile" : "desktop"}):\n${lines.join("\n")}`);
});
