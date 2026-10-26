/**
 * "Allocate <person>'s cost" (work_allocations), the React form-reset bug
 * of e2e/cost-allocation-save-keeps-rows.spec.ts on this screen: React
 * resets a form after its action finishes. After a saved allocation the
 * project went blank but the amount (AmountInput's state) stayed, so the
 * next amount typed was appended to it ("80.000.100.000"); after a refused
 * one the project went back to "Select a project". Three allocations to
 * three different jobs, added one by one: each is listed with its own job
 * right after saving and after reloading, and the form comes back empty for
 * the next one. One the database refuses (more than the remainder) keeps
 * the job and amount that were typed. Throwaway Chilean company in
 * inma-erp-dev. Run with `npm run test:e2e` after `npm run build`.
 */
import { expect, test, type Page } from "@playwright/test";
import { admin, assertDev, createCompany, createMember, deleteCompanies, deleteUser, formatAmount, newTag, ok, signIn, type Member } from "./helpers/devSession";

const tag = newTag();
const TOTAL = 300_000;
const ids = { company: "", person: "", cost: "", projects: [] as string[] };
const projectName = (n: number) => `${tag} trabajo ${n}`;
let member: Member;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  assertDev();
  const db = admin();
  ids.company = await createCompany(`${tag} CL`, "CL", "CLP");
  const client = await ok<{ id: string }>(db.from("clients").insert({ company_id: ids.company, name: `${tag} cliente` }).select("id").single(), "client");
  const area = await ok<{ id: string }>(db.from("business_areas").insert({ company_id: ids.company, name: `${tag} area` }).select("id").single(), "area");
  for (const n of [1, 2, 3]) {
    const project = await ok<{ id: string }>(
      db
        .from("projects")
        .insert({ company_id: ids.company, client_id: client.id, business_area_id: area.id, name: projectName(n), status: "en_ejecucion" })
        .select("id")
        .single(),
      `project ${n}`,
    );
    ids.projects.push(project.id);
  }
  member = await createMember(tag, [ids.company]);
  const person = await ok<{ id: string }>(
    db.from("personnel").insert({ company_id: ids.company, name: `${tag} Empleado`, type: "employee" }).select("id").single(),
    "employee",
  );
  ids.person = person.id;
  const cost = await ok<{ id: string }>(
    db.from("personnel_costs").insert({ personnel_id: person.id, period: "2026-10-01", amount: TOTAL, currency: "CLP" }).select("id").single(),
    "personnel cost",
  );
  ids.cost = cost.id;
});

test.afterAll(async () => {
  const failures = [...(await deleteCompanies([ids.company].filter(Boolean))), ...(await deleteUser(member?.userId))];
  expect(failures).toEqual([]);
});

const project = (page: Page) => page.getByLabel("Project");
const amount = (page: Page) => page.getByLabel("Amount (CLP)");
const listed = (page: Page) => page.getByRole("listitem");

async function expectListed(page: Page, rows: { n: number; amount: number }[]) {
  await expect(listed(page)).toHaveCount(rows.length);
  for (const [index, row] of rows.entries()) {
    await expect(listed(page).nth(index)).toContainText(projectName(row.n));
    await expect(listed(page).nth(index)).toContainText(`${formatAmount(row.amount, "CLP")} CLP`);
  }
}

test("three allocations to three different jobs each keep their job after saving and after reloading", async ({ page, context }) => {
  await signIn(context, member);
  await page.goto(`/companies/${ids.company}/personnel/${ids.person}/costs/${ids.cost}/allocate`);
  await expect(page.getByRole("heading", { name: /Allocate .* cost/ })).toBeVisible();

  // Not the list order: 2, 3, 1. Only the last one is the first of the list.
  const rows = [
    { n: 2, amount: 100_000 },
    { n: 3, amount: 80_000 },
    { n: 1, amount: 50_000 },
  ];
  for (const [index, row] of rows.entries()) {
    await project(page).selectOption(ids.projects[row.n - 1]);
    await amount(page).pressSequentially(String(row.amount));
    await page.getByRole("button", { name: "Add allocation" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Allocation saved." })).toBeVisible();
    // Right after saving, without reloading: every saved job is listed with its own name...
    await expectListed(page, rows.slice(0, index + 1));
    // ...and the form is empty for the next one.
    await expect(project(page)).toHaveValue("");
    await expect(amount(page)).toHaveValue("");
  }
  await page.screenshot({ path: test.info().outputPath("after-save.png"), fullPage: true });

  const saved = await ok<{ project_id: string; amount: number }[]>(
    admin().from("work_allocations").select("project_id, amount").eq("personnel_cost_id", ids.cost).order("created_at"),
    "saved allocations",
  );
  expect(saved.map((row) => ({ ...row, amount: Number(row.amount) }))).toEqual(
    rows.map((row) => ({ project_id: ids.projects[row.n - 1], amount: row.amount })),
  );

  // More than what is left: refused, and the job and amount stay as typed.
  await project(page).selectOption(ids.projects[2]);
  await amount(page).pressSequentially("90000");
  await page.getByRole("button", { name: "Add allocation" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "would exceed" })).toBeVisible();
  await expect(project(page)).toHaveValue(ids.projects[2]);
  await expect(amount(page)).toHaveValue(formatAmount(90_000, "CLP"));

  await page.reload();
  await expectListed(page, rows);
});
