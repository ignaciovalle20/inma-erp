/**
 * "Asignar a servicios" after "Guardar asignación a servicios", the bug of
 * e2e/cost-allocation-save-keeps-rows.spec.ts on this screen: React resets
 * a form after its action finishes, and the controlled service <select>s
 * went back to their first enabled option in the DOM while the state still
 * held the saved rows -- every row showed the first service of the list
 * until the page was reloaded. Three rows with three different services,
 * saved: each row keeps showing its own service, right after saving and
 * after reopening. Throwaway Chilean company in inma-erp-dev. Run with
 * `npm run test:e2e` after `npm run build`.
 */
import { expect, test, type Page } from "@playwright/test";
import { admin, assertDev, createCompany, createMember, deleteCompanies, deleteUser, formatAmount, newTag, ok, signIn, type Member } from "./helpers/devSession";

const tag = newTag();
const ids = { company: "", doc: "", periods: [] as string[] };
let member: Member;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  assertDev();
  const db = admin();
  ids.company = await createCompany(`${tag} CL`, "CL", "CLP");
  const client = await ok<{ id: string }>(db.from("clients").insert({ company_id: ids.company, name: `${tag} cliente` }).select("id").single(), "client");
  const supplier = await ok<{ id: string }>(db.from("suppliers").insert({ company_id: ids.company, name: `${tag} Starlink` }).select("id").single(), "supplier");
  member = await createMember(tag, [ids.company]);
  for (const n of [1, 2, 3]) {
    const service = await ok<{ id: string }>(
      member.client
        .from("recurring_services")
        .insert({
          company_id: ids.company,
          client_id: client.id,
          name: `${tag} Starlink ${n}`,
          currency: "CLP",
          reference_amount: 80000,
          periodicity: "monthly",
          invoicing_mode: "advance",
          start_date: "2026-10-01",
          end_date: "2026-10-31",
          service_type: "starlink",
          fixed_cost: 20000,
          cost_periodicity: "monthly",
          supplier_id: supplier.id,
          status: "active",
          active: true,
        })
        .select("id")
        .single(),
      `service ${n}`,
    );
    const period = await ok<{ id: string }>(
      db.from("recurring_service_cost_periods").select("id").eq("recurring_service_id", service.id).eq("period", "2026-10-01").single(),
      `cost period ${n}`,
    );
    ids.periods.push(period.id);
  }
  const doc = await ok<{ id: string }>(
    member.client
      .rpc("create_cost_document", {
        p_company_id: ids.company,
        p_supplier_id: supplier.id,
        p_project_id: null,
        p_classification: "general",
        p_document_date: "2026-10-05",
        p_currency: "CLP",
        p_tax_amount: 0,
        p_lines: [{ description: `${tag} Starlink octubre`, amount: 90000 }],
      })
      .select()
      .single(),
    "purchase invoice",
  );
  ids.doc = doc.id;
});

test.afterAll(async () => {
  const failures = [...(await deleteCompanies([ids.company].filter(Boolean))), ...(await deleteUser(member?.userId))];
  expect(failures).toEqual([]);
});

const service = (page: Page, row: number) => page.getByLabel("Servicio y período").nth(row);
const amount = (page: Page, row: number) => page.getByLabel("Monto").nth(row);

test("three rows with three different services keep their service after saving and after reopening", async ({ page, context }) => {
  await signIn(context, member);
  await page.goto(`/companies/${ids.company}/costs/${ids.doc}/services`);
  await expect(page.getByRole("heading", { name: "Asignar a servicios" })).toBeVisible();

  // It opens with the month's services of the supplier, in list order:
  // start from scratch so every row is set here.
  while ((await page.getByRole("button", { name: "Quitar servicio" }).count()) > 0) {
    await page.getByRole("button", { name: "Quitar servicio" }).first().click();
  }
  // Not the list order: 2, 3, 1. Rows 1 and 2 are not the first of the list.
  const order = [2, 3, 1];
  const amounts = [40000, 30000, 20000];
  for (const [row, n] of order.entries()) {
    await page.getByRole("button", { name: "+ Agregar servicio" }).click();
    await service(page, row).selectOption(ids.periods[n - 1]);
    await amount(page, row).pressSequentially(String(amounts[row]));
  }
  await page.getByRole("button", { name: "Guardar asignación a servicios" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Asignación a servicios guardada." })).toBeVisible();

  // Right after saving, without reloading: each row still shows its own service.
  for (const [row, n] of order.entries()) await expect(service(page, row)).toHaveValue(ids.periods[n - 1]);
  await page.screenshot({ path: test.info().outputPath("after-save.png"), fullPage: true });

  const saved = await ok<{ cost_period_id: string; amount: number }[]>(
    admin().from("cost_service_allocations").select("cost_period_id, amount").eq("cost_document_id", ids.doc),
    "saved allocations",
  );
  const expected = order.map((n, row) => ({ cost_period_id: ids.periods[n - 1], amount: amounts[row] }));
  const byPeriod = (a: { cost_period_id: string }, b: { cost_period_id: string }) => a.cost_period_id.localeCompare(b.cost_period_id);
  expect(saved.map((row) => ({ ...row, amount: Number(row.amount) })).sort(byPeriod)).toEqual(expected.sort(byPeriod));

  // Saving again from the same screen keeps them too.
  await page.getByRole("button", { name: "Guardar asignación a servicios" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Asignación a servicios guardada." })).toBeVisible();
  for (const [row, n] of order.entries()) await expect(service(page, row)).toHaveValue(ids.periods[n - 1]);

  // Reopened in the database's order (not the saved one): each service with its amount.
  await page.reload();
  await expect(service(page, 0)).toBeVisible();
  const reopened: string[] = [];
  for (const row of order.keys()) reopened.push(`${await service(page, row).inputValue()} ${await amount(page, row).inputValue()}`);
  expect(reopened.sort()).toEqual(order.map((n, row) => `${ids.periods[n - 1]} ${formatAmount(amounts[row], "CLP")}`).sort());
});
