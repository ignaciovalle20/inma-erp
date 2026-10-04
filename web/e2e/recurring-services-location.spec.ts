/**
 * Servicios recurrentes moved from Configuración to Gestión (with Reparto
 * licencias MS under Costos): the menu shows it in the right group, the
 * section has its three tabs, the old URLs redirect to the new ones with no
 * 404, and the dashboard card links to the board.
 *
 * Runs as a throwaway member of a throwaway Chile company in inma-erp-dev,
 * created through the admin API and signed in server-side (the session
 * cookies are handed to the browser -- no credentials are typed into the
 * page). Everything is deleted in afterAll.
 */
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { loadEnvConfig } from "@next/env";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

loadEnvConfig(path.resolve(__dirname, ".."));

const DEV_PROJECT_REF = "sczgankronafrxybpvnh";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

const tag = `zz-test-e2e-${randomUUID().slice(0, 8)}`;
const ids = { company: "", client: "", service: "", pool: "", user: "" };
let cookies: { name: string; value: string }[] = [];

function admin() {
  return createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
}

test.beforeAll(async () => {
  if (new URL(url).host !== `${DEV_PROJECT_REF}.supabase.co`) {
    throw new Error(`E2E only runs against inma-erp-dev (${DEV_PROJECT_REF}).`);
  }
  const db = admin();

  const { data: company, error: companyError } = await db
    .from("companies")
    .insert({ name: tag, country: "CL", currency: "CLP" })
    .select("id")
    .single();
  if (companyError) throw companyError;
  ids.company = company.id;

  const { data: client, error: clientError } = await db
    .from("clients")
    .insert({ company_id: company.id, name: `${tag} cliente` })
    .select("id")
    .single();
  if (clientError) throw clientError;
  ids.client = client.id;

  const { data: service, error: serviceError } = await db
    .from("recurring_services")
    .insert({
      company_id: company.id,
      client_id: client.id,
      name: `${tag} hosting`,
      price: 1000,
      currency: "CLP",
      periodicity: "monthly",
      invoicing_mode: "advance",
      due_day: 5,
      service_type: "hosting",
      start_date: "2026-09-01",
    })
    .select("id")
    .single();
  if (serviceError) throw serviceError;
  ids.service = service.id;

  const { data: pool, error: poolError } = await db
    .from("recurring_service_cost_pools")
    .insert({
      company_id: company.id,
      service_type: "ms_licenses",
      period: "2026-09-01",
      total_expense_amount: 500,
      currency: "CLP",
    })
    .select("id")
    .single();
  if (poolError) throw poolError;
  ids.pool = pool.id;

  const email = `${tag}@example.test`;
  const password = randomBytes(24).toString("base64url");
  const { data: created, error: userError } = await db.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (userError) throw userError;
  ids.user = created.user.id;

  const { error: membershipError } = await db
    .from("company_memberships")
    .insert({ user_id: created.user.id, company_id: company.id, role: "admin" });
  if (membershipError) throw membershipError;

  // Sign in the way the app's server client does, capturing the session
  // cookies it would set.
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
  if (ids.company) {
    const { data: services } = await db.from("recurring_services").select("id").eq("company_id", ids.company);
    const serviceIds = (services ?? []).map((s) => s.id);
    if (serviceIds.length > 0) {
      await db.from("recurring_service_occurrences").delete().in("recurring_service_id", serviceIds);
      await db.from("recurring_services").delete().in("id", serviceIds);
    }
    await db.from("recurring_service_cost_pools").delete().eq("company_id", ids.company);
    await db.from("company_memberships").delete().eq("company_id", ids.company);
    await db.from("clients").delete().eq("company_id", ids.company);
    await db.from("business_areas").delete().eq("company_id", ids.company);
    await db.from("companies").delete().eq("id", ids.company);
  }
  if (ids.user) await db.auth.admin.deleteUser(ids.user);
});

async function signIn(context: BrowserContext) {
  await context.addCookies(
    cookies.map((c) => ({ ...c, domain: "localhost", path: "/", sameSite: "Lax" as const })),
  );
}

/** The sidebar's groups, as { GROUP: [item labels] }. */
async function sidebarGroups(page: Page): Promise<Record<string, string[]>> {
  return page.locator("aside nav > div").evaluateAll((groups) =>
    Object.fromEntries(
      groups.map((group) => [
        (group.firstElementChild?.textContent ?? "").trim(),
        [...group.querySelectorAll("a")].map((a) => (a.textContent ?? "").trim()),
      ]),
    ),
  );
}

test("the menu shows Servicios recurrentes in Gestión, right after Proyectos, and not in Configuración", async ({
  page,
  context,
}) => {
  await signIn(context);
  await page.goto(`/companies/${ids.company}`);
  const groups = await sidebarGroups(page);

  expect(groups["GESTIÓN"]).toEqual(["Resumen", "Ventas", "Costos", "Proyectos", "Servicios recurrentes"]);
  expect(groups["CONFIGURACIÓN"]).toBeDefined();
  expect(groups["CONFIGURACIÓN"]).not.toContain("Servicios recurrentes");

  await page.locator("aside nav").getByRole("link", { name: "Servicios recurrentes" }).click();
  await expect(page).toHaveURL(new RegExp(`/companies/${ids.company}/recurring-services$`));
});

test("the section has three tabs, Tablero del mes by default", async ({ page, context }) => {
  await signIn(context);
  await page.goto(`/companies/${ids.company}/recurring-services`);

  const tabs = page.locator("main nav").filter({ hasText: "Tablero del mes" }).getByRole("link");
  // Deuda carries its open-cycle count ("Deuda 1").
  await expect(tabs).toHaveText(["Tablero del mes", /^Deuda\s*\d*$/, "Servicios"]);
  await expect(tabs.first()).toHaveAttribute("aria-current", "page");
  await expect(page.getByText(`${tag} hosting`).first()).toBeVisible();

  await tabs.nth(2).click();
  await expect(page).toHaveURL(/\/recurring-services\/services$/);
  await expect(page.getByRole("link", { name: "Nuevo servicio" })).toHaveAttribute(
    "href",
    `/companies/${ids.company}/recurring-services/services/new`,
  );
});

test("old URLs redirect to the new ones without a 404", async ({ page, context }) => {
  await signIn(context);
  const base = `/companies/${ids.company}`;
  const cases: [string, string][] = [
    [`${base}/recurring-services/pending`, `${base}/recurring-services/debt`],
    [`${base}/recurring-services/new`, `${base}/recurring-services/services/new`],
    [`${base}/recurring-services/${ids.service}`, `${base}/recurring-services/services/${ids.service}`],
    [`${base}/recurring-services/${ids.service}/edit`, `${base}/recurring-services/services/${ids.service}/edit`],
    [`${base}/recurring-services/cost-pools`, `${base}/costs/ms-licenses`],
    [`${base}/recurring-services/cost-pools/new`, `${base}/costs/ms-licenses/new`],
    [`${base}/recurring-services/cost-pools/${ids.pool}`, `${base}/costs/ms-licenses/${ids.pool}`],
  ];

  for (const [oldUrl, newUrl] of cases) {
    const response = await page.goto(oldUrl);
    expect(response?.status(), oldUrl).toBe(200);
    expect(new URL(page.url()).pathname, oldUrl).toBe(newUrl);
    await expect(page.getByText("This page could not be found")).toHaveCount(0);
  }

  // Query strings survive the redirect.
  await page.goto(`${base}/recurring-services/pending?x=1`);
  expect(new URL(page.url()).search).toBe("?x=1");
});

test("Reparto licencias MS lives under Costos", async ({ page, context }) => {
  await signIn(context);
  await page.goto(`/companies/${ids.company}/costs`);
  await page.getByRole("link", { name: "Reparto licencias MS" }).click();
  await expect(page).toHaveURL(new RegExp(`/companies/${ids.company}/costs/ms-licenses$`));
  await expect(page.getByRole("heading", { name: "Reparto licencias MS" })).toBeVisible();
  // Costos stays highlighted in the menu.
  await expect(page.locator("aside nav").getByRole("link", { name: "Costos" })).toHaveClass(/font-semibold/);
});

test("the dashboard card shows this month's counts and leads to the board", async ({ page, context }) => {
  await signIn(context);
  // Opening the board creates this month's cycle (pending invoice).
  await page.goto(`/companies/${ids.company}/recurring-services`);
  await page.goto(`/companies/${ids.company}`);

  const card = page.getByRole("link", { name: /^Servicios del mes:/ });
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute("aria-label", /1 por facturar, 0 por cobrar, \d+ vencidos/);
  await card.click();
  await expect(page).toHaveURL(new RegExp(`/companies/${ids.company}/recurring-services$`));
});
