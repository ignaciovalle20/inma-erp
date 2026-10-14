/**
 * Same features for every company, with the currency rule of each
 * (docs/cambios-pago-multimoneda-paridad-2026-10-14.md, Tarea 3): Chile never
 * asks the currency (CLP fixed), Uruguay requires USD or UYU with no default,
 * on the sale and cost forms, the job's quick expense and the quick sale
 * entry (now in both companies). No screen nor the guide says "solo Chile"
 * or "solo Uruguay". Saved documents are checked in the database.
 */
import { expect, test, type Page } from "@playwright/test";
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
  snap,
  type Member,
} from "./helpers/devSession";

const tag = newTag();
const ids = { cl: "", uy: "", clClient: "", uyClient: "", clSale: "", uySale: "", uyProject: "" };
let member: Member;

test.describe.configure({ mode: "serial" });

async function sale(companyId: string, clientId: string, number: string, currency: string, net: number) {
  const db = admin();
  const row = await ok<{ id: string }>(
    db
      .from("sales_documents")
      .insert({
        company_id: companyId,
        client_id: clientId,
        document_type: "manual",
        document_number: number,
        document_date: "1995-08-10",
        currency,
        net_amount: net,
        tax_amount: 0,
        total_amount: net,
        source: "manual",
      })
      .select("id")
      .single(),
    `sale ${number}`,
  );
  await ok(db.from("sales_lines").insert({ sales_document_id: row.id, description: number, amount: net }).select("id"), "line");
  return row.id;
}

test.beforeAll(async () => {
  assertDev();
  const db = admin();
  ids.cl = await createCompany(`${tag} CL`, "CL", "CLP");
  ids.uy = await createCompany(`${tag} UY`, "UY", "UYU");
  member = await createMember(tag, [ids.cl, ids.uy]);
  ids.clClient = (await ok<{ id: string }>(db.from("clients").insert({ company_id: ids.cl, name: `${tag} cliente cl` }).select("id").single(), "client")).id;
  ids.uyClient = (await ok<{ id: string }>(db.from("clients").insert({ company_id: ids.uy, name: `${tag} cliente uy` }).select("id").single(), "client")).id;
  ids.clSale = await sale(ids.cl, ids.clClient, `${tag}-CL`, "CLP", 10_000);
  ids.uySale = await sale(ids.uy, ids.uyClient, `${tag}-UY`, "UYU", 4_000);

  const area = (await ok<{ id: string }[]>(db.from("business_areas").select("id").eq("company_id", ids.uy).limit(1), "areas"))[0];
  const { data, error } = await member.client.rpc("create_project_with_quote", {
    p_company_id: ids.uy,
    p_client_id: ids.uyClient,
    p_business_area_id: area.id,
    p_name: `${tag} trabajo`,
    p_status: "en_ejecucion",
    p_quote_number: `${tag}-COT`,
    p_start_date: "1995-01-01",
    p_end_date: null,
    p_budget: null,
    p_responsible: null,
    p_invoiceable: true,
  });
  if (error) throw new Error(`project: ${error.message}`);
  ids.uyProject = (data as { id: string }).id;
});

test.afterAll(async () => {
  const failures = [...(await deleteCompanies([ids.cl, ids.uy].filter(Boolean))), ...(await deleteUser(member?.userId))];
  expect(failures).toEqual([]);
});

async function expectFixedClp(page: Page) {
  await expect(page.locator("select#currency")).toHaveCount(0);
  await expect(page.getByText("(única moneda de la empresa)")).toBeVisible();
  await expect(page.locator('input[type="hidden"][name="currency"]')).toHaveValue("CLP");
}

async function expectUsdOrUyuChoice(page: Page, value: string) {
  const select = page.locator("select#currency");
  await expect(select).toHaveValue(value);
  await expect(select).toHaveAttribute("required", "");
  const options = await select.locator("option").evaluateAll((all) =>
    all.map((option) => ({ value: (option as HTMLOptionElement).value, disabled: (option as HTMLOptionElement).disabled })),
  );
  expect(options).toEqual([
    { value: "", disabled: true },
    { value: "USD", disabled: false },
    { value: "UYU", disabled: false },
  ]);
}

test("CL: new and edit sale, and new cost, never ask the currency (CLP fixed)", async ({ page, context }) => {
  await signIn(context, member);
  for (const path of [`sales/new`, `sales/${ids.clSale}/edit`, `costs/new`]) {
    await page.goto(`/companies/${ids.cl}/${path}`);
    await expectFixedClp(page);
  }
  await snap(page, "moneda-01-cl-gasto-nuevo");
});

test("UY: new sale and new cost require USD or UYU with no default; editing keeps the sale's own", async ({ page, context }) => {
  await signIn(context, member);
  await page.goto(`/companies/${ids.uy}/sales/new`);
  await expectUsdOrUyuChoice(page, "");
  await snap(page, "moneda-02-uy-venta-nueva");
  await page.goto(`/companies/${ids.uy}/costs/new`);
  await expectUsdOrUyuChoice(page, "");
  await page.goto(`/companies/${ids.uy}/sales/${ids.uySale}/edit`);
  await expectUsdOrUyuChoice(page, "UYU");
});

test("UY: the job's quick expense asks the currency and saves it", async ({ page, context }) => {
  await signIn(context, member);
  await page.goto(`/companies/${ids.uy}/projects/${ids.uyProject}/quick-expense`, { waitUntil: "networkidle" });
  await expectUsdOrUyuChoice(page, "");
  await page.locator("select#currency").selectOption("USD");
  await page.locator("#amount").fill("250");
  await page.getByText("Materiales", { exact: true }).click();
  await page.getByRole("button", { name: "Guardar" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Gasto guardado." })).toBeVisible();
  await snap(page, "moneda-03-uy-gasto-rapido");

  const costs = await ok<{ currency: string; net_amount: number; project_id: string }[]>(
    admin().from("cost_documents").select("currency, net_amount, project_id").eq("company_id", ids.uy),
    "costs",
  );
  expect(costs.map((c) => ({ ...c, net_amount: Number(c.net_amount) }))).toEqual([
    { currency: "USD", net_amount: 250, project_id: ids.uyProject },
  ]);
});

test("the quick sale entry exists in both companies, with each one's currency rule", async ({ page, context }) => {
  await signIn(context, member);
  for (const company of [
    { id: ids.cl, clientId: ids.clClient, currency: "CLP", amount: "12000" },
    { id: ids.uy, clientId: ids.uyClient, currency: "USD", amount: "75" },
  ]) {
    await page.goto(`/companies/${company.id}/sales`);
    await page.getByRole("link", { name: "Carga rápida" }).click();
    await expect(page).toHaveURL(new RegExp(`/companies/${company.id}/sales/quick$`));
    await page.waitForLoadState("networkidle");
    if (company.currency === "CLP") {
      await expectFixedClp(page);
    } else {
      await expectUsdOrUyuChoice(page, "");
      await page.locator("select#currency").selectOption(company.currency);
    }
    await page.locator("#client_id").selectOption(company.clientId);
    await page.locator("#amount").fill(company.amount);
    await page.locator("#business_area_id").selectOption({ index: 1 });
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
    await snap(page, `moneda-04-carga-rapida-${company.currency}`);

    const saved = await ok<{ currency: string; net_amount: number }[]>(
      admin().from("sales_documents").select("currency, net_amount").eq("company_id", company.id).is("document_number", null),
      "quick sale",
    );
    expect(saved.map((s) => ({ ...s, net_amount: Number(s.net_amount) }))).toEqual([
      { currency: company.currency, net_amount: Number(company.amount) },
    ]);
  }
});

test("no screen and no guide says 'solo Chile' or 'solo Uruguay'", async ({ page, context }) => {
  await signIn(context, member);
  for (const company of [ids.cl, ids.uy]) {
    for (const path of ["guide", "sales", "sales/import", "sales/quick", "costs", "costs/import", "recurring-services"]) {
      await page.goto(`/companies/${company}/${path}`);
      await expect(page.locator("body"), `${company}/${path}`).not.toContainText(/solo (Chile|Uruguay)/i);
    }
    await page.goto(`/companies/${company}/guide`);
    await expect(page.locator("main")).toContainText("todas las empresas");
  }
  await snap(page, "moneda-05-guia");
});
