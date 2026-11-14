/**
 * Cuenta corriente of a technician per currency (20261114010000), on
 * throwaway companies of inma-erp-dev deleted at the end:
 *
 * 1. Uruguay: a technician with two charges in USD and one in UYU. The
 *    cuenta corriente shows one block of saldo, cargos and pagos per
 *    currency; the payment form starts in USD (most pending charges), lists
 *    only that currency's charges, and a payment in each currency lowers only
 *    that currency's saldo. The personnel list shows both saldos.
 * 2. Chile: one block, no currency asked, as before.
 * 3. Rentabilidad: the job's technicians are left out of its UYU figures
 *    when in USD (as on its page) and converted in the company's totals.
 *
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
  formatAmount,
  newTag,
  ok,
  signIn,
  snap,
  type Member,
} from "./helpers/devSession";

const tag = newTag();
const ids = { uy: "", cl: "", uyProject: "", clProject: "", uyTech: "", clTech: "" };
let member: Member;

test.describe.configure({ mode: "serial" });

async function seed(company: string, country: string, currency: string) {
  const db = admin();
  const client = await ok<{ id: string }>(
    db.from("clients").insert({ company_id: company, name: `${tag} cliente ${country}` }).select("id").single(),
    "client",
  );
  const area = (await ok<{ id: string }[]>(db.from("business_areas").select("id").eq("company_id", company).limit(1), "areas"))[0];
  const project = await ok<{ id: string }>(
    db
      .from("projects")
      .insert({
        company_id: company,
        client_id: client.id,
        business_area_id: area.id,
        name: `${tag} trabajo ${country}`,
        status: "en_ejecucion",
        currency,
        start_date: "2026-10-01",
      })
      .select("id")
      .single(),
    "project",
  );
  const technician = await ok<{ id: string }>(
    db.from("personnel").insert({ company_id: company, name: `${tag} Técnico ${country}`, type: "contractor" }).select("id").single(),
    "technician",
  );
  return { project: project.id, technician: technician.id };
}

async function charge(project: string, technician: string, amount: number, date: string, currency?: string) {
  await ok(
    member.client.rpc("create_technician_charge", {
      p_project_id: project,
      p_personnel_id: technician,
      p_description: `${tag} cargo`,
      p_charge_date: date,
      p_amount: amount,
      p_vat_included: false,
      p_vat_rate: 0,
      ...(currency ? { p_currency: currency } : {}),
    }),
    "charge",
  );
}

test.beforeAll(async () => {
  assertDev();
  ids.uy = await createCompany(`${tag} UY`, "UY", "UYU");
  ids.cl = await createCompany(`${tag} CL`, "CL", "CLP");
  member = await createMember(tag, [ids.uy, ids.cl]);
  const uy = await seed(ids.uy, "UY", "UYU");
  ids.uyProject = uy.project;
  ids.uyTech = uy.technician;
  const cl = await seed(ids.cl, "CL", "CLP");
  ids.clProject = cl.project;
  ids.clTech = cl.technician;

  await charge(ids.uyProject, ids.uyTech, 300, "2026-10-05", "USD");
  await charge(ids.uyProject, ids.uyTech, 200, "2026-10-20", "USD");
  await charge(ids.uyProject, ids.uyTech, 8000, "2026-10-10", "UYU");
  await charge(ids.clProject, ids.clTech, 100000, "2026-10-10");
});

test.afterAll(async () => {
  const failures = [...(await deleteCompanies([ids.uy, ids.cl].filter(Boolean))), ...(await deleteUser(member?.userId))];
  expect(failures).toEqual([]);
});

test("Uruguay: saldo, cargos and pagos per currency; a payment only touches its currency", async ({ page, context }) => {
  await signIn(context, member);
  await page.goto(`/companies/${ids.uy}/personnel/${ids.uyTech}/account`);

  const saldo = (currency: string) => page.getByLabel(`Saldo en ${currency}`);
  await expect(saldo("USD")).toContainText(`Saldo a pagar · USD${formatAmount(500, "USD")}`);
  await expect(saldo("UYU")).toContainText(`Saldo a pagar · UYU${formatAmount(8000, "UYU")}`);
  await expect(page.getByRole("heading", { name: "Cargos por trabajo · USD" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Cargos por trabajo · UYU" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Pagos · USD" })).toBeVisible();

  // The form starts in USD (two of the three pending charges) with its two charges only.
  const currency = page.getByLabel("Moneda del pago");
  await expect(currency).toHaveValue("USD");
  await expect(page.getByLabel(/^Aplicar a /)).toHaveCount(2);
  await snap(page, "tech-currency-1-cuenta");

  // USD 350: the oldest charge whole and 50 of the next.
  await page.getByLabel("Monto del pago (USD)").fill("350");
  await page.getByRole("button", { name: "Registrar pago" }).click();
  await expect(saldo("USD")).toContainText(`Saldo a pagar · USD${formatAmount(150, "USD")}`);
  await expect(saldo("UYU")).toContainText(`Saldo a pagar · UYU${formatAmount(8000, "UYU")}`);

  // UYU: only its one charge is offered; USD 150 still owed is not payable from here.
  await page.getByLabel("Moneda del pago").selectOption("UYU");
  await expect(page.getByLabel(/^Aplicar a /)).toHaveCount(1);
  await page.getByLabel("Monto del pago (UYU)").fill("3000");
  await page.getByRole("button", { name: "Registrar pago" }).click();
  await expect(saldo("UYU")).toContainText(`Saldo a pagar · UYU${formatAmount(5000, "UYU")}`);
  await expect(saldo("USD")).toContainText(`Saldo a pagar · USD${formatAmount(150, "USD")}`);
  await snap(page, "tech-currency-2-pagos");

  const payments = await ok<{ currency: string; amount: number }[]>(
    admin().from("technician_payments").select("currency, amount").eq("company_id", ids.uy).order("currency"),
    "payments",
  );
  expect(payments.map((row) => [row.currency, Number(row.amount)])).toEqual([
    ["USD", 350],
    ["UYU", 3000],
  ]);

  // The personnel list: both saldos, each with its currency.
  await page.goto(`/companies/${ids.uy}/personnel`);
  const row = page.getByRole("row").filter({ hasText: `${tag} Técnico UY` });
  await expect(row).toContainText(`${formatAmount(150, "USD")}USD`);
  await expect(row).toContainText(`${formatAmount(5000, "UYU")}UYU`);
  await snap(page, "tech-currency-3-personal");
});

test("Chile: one block in CLP and no currency asked", async ({ page, context }) => {
  await signIn(context, member);
  await page.goto(`/companies/${ids.cl}/personnel/${ids.clTech}/account`);
  await expect(page.getByRole("heading", { name: "Cargos por trabajo", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Pagos", exact: true })).toBeVisible();
  await expect(page.getByLabel("Moneda del pago")).toHaveCount(0);
  await expect(page.locator("main")).toContainText(`Saldo a pagar${formatAmount(100000, "CLP")}`);

  await page.getByLabel("Monto del pago (CLP)").fill("40000");
  await page.getByRole("button", { name: "Registrar pago" }).click();
  await expect(page.locator("main")).toContainText(`Saldo a pagar${formatAmount(60000, "CLP")}`);
  const payment = await ok<{ currency: string }>(
    admin().from("technician_payments").select("currency").eq("company_id", ids.cl).single(),
    "payment",
  );
  expect(payment.currency).toBe("CLP");
  await snap(page, "tech-currency-4-chile");
});

test("Rentabilidad: the job as on its page; the company's total converts the USD technicians and says so", async ({ page, context }) => {
  await signIn(context, member);
  await page.goto(`/companies/${ids.uy}/reports/profitability`);
  const job = page.getByRole("row").filter({ hasText: `${tag} trabajo UY` });
  // Técnicos of the job in UYU: 8.000; the USD 500 are left out, with a notice.
  await expect(job).toContainText(formatAmount(8000, "UYU"));
  await expect(job).toContainText("No incluye montos en otra moneda");
  await expect(job).toContainText(`${formatAmount(500, "USD")}USD`);
  await expect(page.getByLabel("Total de la empresa")).toContainText("Incluye montos convertidos a UYU");
  await snap(page, "tech-currency-5-rentabilidad");

  // The job's own page shows the same figures.
  await page.goto(`/companies/${ids.uy}/projects/${ids.uyProject}`);
  const summary = page.getByLabel("Resumen del proyecto");
  await expect(summary).toContainText(`Total técnicos${formatAmount(8000, "UYU")}`);
  await expect(summary).toContainText("No incluye montos en otra moneda");
});
