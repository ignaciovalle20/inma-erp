/**
 * MS licenses split per invoice (fix-ms-invoice 2026-11, migration
 * 20261109010000), on a throwaway Chilean company in inma-erp-dev: two
 * Intcomex invoices in January 2026, the licenses one (300) and a hardware one
 * (700). Only the licenses invoice is suggested (list and detail); the hardware
 * one only offers the button. Splitting it shows the preview (total = its net),
 * a second licenses invoice of the month asks for a confirmation, and the split
 * can be undone. Run with `npm run test:e2e` after `npm run build`.
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
  snap,
  type Member,
} from "./helpers/devSession";

const tag = newTag();
const ids = { cl: "", licenses: "", hardware: "" };
let member: Member;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  assertDev();
  const db = admin();
  ids.cl = await createCompany(`${tag} CL`, "CL", "CLP");
  member = await createMember(tag, [ids.cl]);
  const client = await ok<{ id: string }>(db.from("clients").insert({ company_id: ids.cl, name: `${tag} cliente` }).select("id").single(), "client");
  const supplier = await ok<{ id: string }>(
    db.from("suppliers").insert({ company_id: ids.cl, name: `Intcomex S.A. ${tag}` }).select("id").single(),
    "supplier",
  );
  await ok(
    db
      .from("recurring_services")
      .insert({
        company_id: ids.cl, client_id: client.id, name: `${tag} Licencias`, reference_amount: 500, currency: "CLP",
        periodicity: "monthly", invoicing_mode: "advance", start_date: "2026-01-01", status: "active", active: true,
        service_type: "ms_licenses", uses_cost_pool: true,
      })
      .select("id"),
    "service",
  );
  const invoice = async (date: string, net: number, description: string) =>
    (
      await ok<{ id: string }>(
        member.client
          .rpc("create_cost_document", {
            p_company_id: ids.cl, p_supplier_id: supplier.id, p_project_id: null, p_classification: "general",
            p_document_date: date, p_currency: "CLP", p_tax_amount: 0, p_lines: [{ description, amount: net }],
          })
          .select()
          .single(),
        description,
      )
    ).id;
  ids.licenses = await invoice("2026-01-06", 300, `${tag} licencias`);
  ids.hardware = await invoice("2026-01-16", 700, `${tag} hardware`);
});

test.afterAll(async () => {
  const failures = [...(await deleteCompanies([ids.cl].filter(Boolean))), ...(await deleteUser(member?.userId))];
  expect(failures).toEqual([]);
});

test("only the licenses invoice is suggested; split, second invoice, undo", async ({ page, context }) => {
  await signIn(context, member);

  // Costs list: one suggestion for January, the licenses invoice.
  await page.goto(`/companies/${ids.cl}/costs`);
  const banner = page.getByText("Facturas de licencias MS sin repartir").locator("..");
  await expect(banner).toBeVisible();
  await expect(banner.getByRole("link", { name: "Es la factura de licencias MS → repartir" })).toHaveCount(1);
  await expect(banner.getByRole("link", { name: "Es la factura de licencias MS → repartir" })).toHaveAttribute(
    "href",
    `/companies/${ids.cl}/costs/ms-licenses/propose?document=${ids.licenses}`,
  );
  await snap(page, "ms-invoice-01-costs-list");

  // The hardware invoice: no warning, only the button.
  await page.goto(`/companies/${ids.cl}/costs/${ids.hardware}`);
  await expect(page.getByText("Factura de licencias MS sin repartir")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Es factura de licencias MS → repartir" })).toBeVisible();
  await snap(page, "ms-invoice-02-hardware-detail");

  // The licenses invoice: the warning and the button.
  await page.goto(`/companies/${ids.cl}/costs/${ids.licenses}`);
  await expect(page.getByText("Factura de licencias MS sin repartir")).toBeVisible();
  await page.getByRole("link", { name: "Es la factura de licencias MS → repartir" }).click();

  // Preview: the invoice's net only (300), not the month's 1.000.
  await expect(page.getByText("Total (el neto de la factura)")).toBeVisible();
  const totalRow = page.getByRole("row").filter({ hasText: "Total (el neto de la factura)" });
  await expect(totalRow).toContainText("300");
  await expect(totalRow).not.toContainText("1.000");
  await snap(page, "ms-invoice-03-preview");
  await page.getByRole("button", { name: "Confirmar reparto" }).click();
  await page.waitForURL(/\/costs\/ms-licenses\/[0-9a-f-]{36}$/);
  const poolUrl = page.url();
  await expect(page.getByRole("button", { name: "Deshacer reparto" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Ver la factura de licencias" })).toBeVisible();
  await snap(page, "ms-invoice-04-pool");

  // The list has no suggestion left for January.
  await page.goto(`/companies/${ids.cl}/costs`);
  await expect(page.getByText("Facturas de licencias MS sin repartir")).toHaveCount(0);

  // Marking the hardware invoice too: a warning and a box to confirm.
  await page.goto(`/companies/${ids.cl}/costs/ms-licenses/propose?document=${ids.hardware}`);
  await expect(page.getByText(/ya tiene una factura de licencias repartida en ene 2026/)).toBeVisible();
  await expect(page.getByRole("checkbox")).toBeVisible();
  await snap(page, "ms-invoice-05-second");

  // Undo the split.
  await page.goto(poolUrl);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Deshacer reparto" }).click();
  await page.waitForURL(new RegExp(`/companies/${ids.cl}/costs/ms-licenses$`));
  await page.goto(`/companies/${ids.cl}/costs/${ids.licenses}`);
  await expect(page.getByText("Factura de licencias MS sin repartir")).toBeVisible();
  await snap(page, "ms-invoice-06-undone");
});
