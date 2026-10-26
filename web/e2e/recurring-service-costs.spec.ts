/**
 * Recurring service costs end to end (docs/servicios-recurrentes-costos.md),
 * on a throwaway Chilean company in inma-erp-dev:
 *
 * 1. "EBCO LA LIGUA - ANUAL" is created through the form: Starlink, annual,
 *    advance, from 2026-07-01, fixed cost 50.000 paid monthly, with its
 *    supplier. Its first cycle is July 2026 (to collect) and it has a cost
 *    period every month since July.
 * 2. A CSV of four equal purchase invoices of that supplier is imported:
 *    each one is allocated and confirmed to one of its four Starlinks.
 * 3. The profitability report shows the annual sale whole in July and the
 *    cost month by month, the October invoices only once.
 *
 * Every result is checked in the database too. Run with `npm run test:e2e`
 * after `npm run build`.
 */
import { expect, test, type Page } from "@playwright/test";
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
const ids = { cl: "", client: "", supplier: "", ebco: "" };
let member: Member;
const clientName = `${tag} EBCO`;
const supplierName = `${tag} Starlink Chile`;

test.describe.configure({ mode: "serial" });

/** The company's month today (Chile), "YYYY-MM". */
const currentMonth = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Santiago", year: "numeric", month: "2-digit" })
  .format(new Date())
  .slice(0, 7);

function monthsFrom(from: string, to: string): string[] {
  const out: string[] = [];
  let [year, month] = from.split("-").map(Number);
  while (`${year}-${String(month).padStart(2, "0")}` <= to) {
    out.push(`${year}-${String(month).padStart(2, "0")}-01`);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return out;
}

async function clientRow(page: Page, period: string) {
  await page.goto(`/companies/${ids.cl}/reports/profitability?period=${period}`);
  await page.getByRole("tab", { name: "Clientes" }).click();
  return page.getByRole("row").filter({ hasText: clientName }).first();
}

test.beforeAll(async () => {
  assertDev();
  ids.cl = await createCompany(`${tag} Chile`, "CL", "CLP");
  member = await createMember(tag, [ids.cl]);
  const db = admin();
  ids.client = (await ok<{ id: string }>(db.from("clients").insert({ company_id: ids.cl, name: clientName }).select("id").single(), "client")).id;
  ids.supplier = (
    await ok<{ id: string }>(db.from("suppliers").insert({ company_id: ids.cl, name: supplierName }).select("id").single(), "supplier")
  ).id;
});

test.afterAll(async () => {
  const failures = [...(await deleteCompanies([ids.cl].filter(Boolean))), ...(await deleteUser(member?.userId))];
  expect(failures).toEqual([]);
});

test("EBCO LA LIGUA - ANUAL: first cycle July 2026, a cost period every month", async ({ page, context }) => {
  await signIn(context, member);
  await page.goto(`/companies/${ids.cl}/recurring-services/services/new`);
  await page.waitForLoadState("networkidle");

  await page.getByLabel("Cliente").selectOption({ label: clientName });
  await page.getByLabel("Nombre del servicio").fill("EBCO LA LIGUA - ANUAL");
  await page.getByLabel("Tipo de servicio").selectOption("starlink");
  await page.locator("#reference_amount").pressSequentially("1200000");
  await page.getByLabel("Periodicidad").selectOption("annual");
  await page.getByLabel("Modalidad de facturación").selectOption("advance");
  await page.getByLabel("Día de vencimiento").fill("1");
  await page.getByLabel("Fecha de inicio").fill("2026-07-01");
  await page.getByLabel("Fecha de fin").fill("2027-06-01");
  // The due month is calculated, never asked.
  await expect(page.getByLabel("Mes de vencimiento")).toHaveCount(0);
  await expect(page.getByText(/Vence cada año en julio/)).toBeVisible();
  await page.locator("#fixed_cost").pressSequentially("50000");
  await expect(page.getByLabel("Se paga")).toHaveValue("monthly");
  await page.getByLabel("Proveedor").selectOption({ label: supplierName });
  await snap(page, "rs-costs-1-form");
  await page.getByRole("button", { name: "Crear servicio recurrente" }).click();

  await page.waitForURL(/recurring-services\/services\/[0-9a-f-]{36}/);
  ids.ebco = page.url().match(/services\/([0-9a-f-]{36})/)![1];
  await expect(page.getByText("Costos del servicio")).toBeVisible();
  await expect(page.getByText(supplierName).first()).toBeVisible();
  await expect(page.getByText(/jul 2026 – jun 2027/).first()).toBeVisible();
  await snap(page, "rs-costs-2-detail");

  const db = admin();
  const service = await ok<{ due_month: number; fixed_cost: number; cost_periodicity: string; supplier_id: string }>(
    db.from("recurring_services").select("due_month, fixed_cost, cost_periodicity, supplier_id").eq("id", ids.ebco).single(),
    "service",
  );
  expect(service).toEqual({ due_month: 7, fixed_cost: 50000, cost_periodicity: "monthly", supplier_id: ids.supplier });
  const cycles = await ok<{ period: string; invoice_due_date: string; status: string }[]>(
    db.from("recurring_service_occurrences").select("period, invoice_due_date, status").eq("recurring_service_id", ids.ebco),
    "cycles",
  );
  expect(cycles).toEqual([{ period: "2026-07-01", invoice_due_date: "2026-07-01", status: "pending_invoice" }]);
  const costPeriods = await ok<{ period: string; expected_amount: number }[]>(
    db.from("recurring_service_cost_periods").select("period, expected_amount").eq("recurring_service_id", ids.ebco).order("period"),
    "cost periods",
  );
  expect(costPeriods.map((row) => row.period)).toEqual(monthsFrom("2026-07", currentMonth));
  expect(costPeriods.every((row) => Number(row.expected_amount) === 50000)).toBe(true);

  // Marked invoiced (collect next): the July cycle is the annual sale.
  await ok(
    db
      .from("recurring_service_occurrences")
      .update({ status: "invoiced", invoiced_at: "2026-07-01" })
      .eq("recurring_service_id", ids.ebco)
      .select("id"),
    "invoice EBCO",
  );
});

test("four equal purchase invoices go to the supplier's four Starlinks, confirmed", async ({ page, context }) => {
  // Three more Starlinks of the same supplier, from October.
  for (const n of [2, 3, 4]) {
    await ok(
      member.client
        .from("recurring_services")
        .insert({
          company_id: ids.cl,
          client_id: ids.client,
          name: `${tag} Starlink ${n}`,
          currency: "CLP",
          reference_amount: 80000,
          periodicity: "monthly",
          invoicing_mode: "advance",
          start_date: `${currentMonth}-01`,
          service_type: "starlink",
          fixed_cost: 50000,
          cost_periodicity: "monthly",
          supplier_id: ids.supplier,
          status: "active",
          active: true,
        })
        .select("id"),
      `starlink ${n}`,
    );
  }

  const day = (d: number) => `${String(d).padStart(2, "0")}/${currentMonth.slice(5, 7)}/${currentMonth.slice(0, 4)}`;
  const csv = ["Fecha;Proveedor;Neto;IVA", ...[3, 5, 7, 9].map((d) => `${day(d)};${supplierName};50.000;9.500`)].join("\r\n");

  await signIn(context, member);
  await page.goto(`/companies/${ids.cl}/costs/import`);
  // The file input reacts only once the form is hydrated.
  await page.waitForLoadState("networkidle");
  await page.locator("#file").setInputFiles({ name: `${tag}.csv`, mimeType: "text/csv", buffer: Buffer.from(`${csv}\r\n`, "utf8") });
  await expect(page.getByText(`${tag}.csv`)).toBeVisible();
  for (const [field, column] of [
    ["Fecha", "Fecha"],
    ["Proveedor", "Proveedor"],
    ["Neto", "Neto"],
    ["IVA", "IVA"],
  ]) {
    await page.getByLabel(`Columna para ${field}`, { exact: true }).selectOption(column);
  }
  await page.getByRole("button", { name: "Previsualizar" }).click();
  await page.getByRole("button", { name: /Importar 4 filas/ }).click();
  await expect(page.getByText("Importación completa")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/Servicios recurrentes: 4 facturas asignadas/)).toBeVisible();
  await snap(page, "rs-costs-3-import");

  const db = admin();
  const documents = ((await db.from("cost_documents").select("id").eq("company_id", ids.cl)).data ?? []).map((row) => row.id);
  expect(documents).toHaveLength(4);
  const allocations = await ok<{ cost_period_id: string; status: string; amount: number }[]>(
    db.from("cost_service_allocations").select("cost_period_id, status, amount").in("cost_document_id", documents),
    "allocations",
  );
  expect(allocations).toHaveLength(4);
  expect(new Set(allocations.map((row) => row.cost_period_id)).size).toBe(4);
  expect(allocations.every((row) => row.status === "confirmed" && Number(row.amount) === 50000)).toBe(true);

  // None of them is a general cost left to assign.
  await page.goto(`/companies/${ids.cl}/costs?period=${currentMonth}&classification=general&unassigned=1`);
  await expect(page.getByText("No hay documentos de costo en este período.")).toBeVisible();
});

test("profitability: the annual sale whole in July, the cost month by month, no duplicates", async ({ page, context }) => {
  await signIn(context, member);
  const cost = formatAmount(50000, "CLP");

  const july = await clientRow(page, "2026-07");
  await expect(july).toContainText(formatAmount(1200000, "CLP"));
  await expect(july).toContainText(cost);
  await snap(page, "rs-costs-4-july");

  const august = await clientRow(page, "2026-08");
  await expect(august).toContainText(cost);
  await expect(august).not.toContainText(formatAmount(1200000, "CLP"));

  // The current month: four Starlinks with their invoice, 4 x 50.000, once.
  const now = await clientRow(page, currentMonth);
  await expect(now).toContainText(formatAmount(200000, "CLP"));
  await snap(page, "rs-costs-5-current");
});
