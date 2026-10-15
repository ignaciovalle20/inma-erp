/**
 * Estado de pago Pagada / Impaga in the sales list and the sale's detail
 * (docs/cambios-pago-multimoneda-paridad-2026-10-14.md, Tarea 1), in a
 * throwaway Uruguayan company of inma-erp-dev: Impaga by default, the row
 * button, the bulk bar with an optional payment date, the Pagadas / Impagas
 * filter, the detail page, and a credit note that carries no payment status.
 * Every change is also checked in the database.
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
const ids = { company: "", client: "", inv1: "", inv2: "", inv3: "", nc: "" };
const folio = { inv1: `${tag}-1`, inv2: `${tag}-2`, inv3: `${tag}-3`, nc: `${tag}-nc` };
let member: Member;

test.describe.configure({ mode: "serial" });

async function sale(type: "invoice" | "credit_note", number: string, date: string, currency: string, net: number) {
  const db = admin();
  const row = await ok<{ id: string }>(
    db
      .from("sales_documents")
      .insert({
        company_id: ids.company,
        client_id: ids.client,
        document_type: type,
        document_number: number,
        document_date: date,
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

async function dbStatus(id: string) {
  return ok<{ payment_status: string; paid_at: string | null }>(
    admin().from("sales_documents").select("payment_status, paid_at").eq("id", id).single(),
    "status",
  );
}

test.beforeAll(async () => {
  assertDev();
  ids.company = await createCompany(`${tag} UY`, "UY", "UYU");
  ids.client = (
    await ok<{ id: string }>(
      admin().from("clients").insert({ company_id: ids.company, name: `${tag} cliente` }).select("id").single(),
      "client",
    )
  ).id;
  ids.inv1 = await sale("invoice", folio.inv1, "1995-06-05", "USD", 1_000);
  ids.inv2 = await sale("invoice", folio.inv2, "1995-06-10", "UYU", 20_000);
  ids.inv3 = await sale("invoice", folio.inv3, "1995-06-15", "UYU", 5_000);
  ids.nc = await sale("credit_note", folio.nc, "1995-06-20", "UYU", 1_000);
  member = await createMember(tag, [ids.company]);
});

test.afterAll(async () => {
  const failures = [...(await deleteCompanies([ids.company].filter(Boolean))), ...(await deleteUser(member?.userId))];
  expect(failures).toEqual([]);
});

const listUrl = () => `/companies/${ids.company}/sales?period=all`;
const row = (page: Page, label: string) => page.locator("tbody tr").filter({ hasText: label });

test("a sale is Impaga by default", async ({ page, context }) => {
  await signIn(context, member);
  await page.goto(listUrl());
  for (const key of ["inv1", "inv2", "inv3"] as const) {
    await expect(row(page, `FAC ${folio[key]}`).getByText("Impaga", { exact: true })).toBeVisible();
    expect(await dbStatus(ids[key])).toEqual({ payment_status: "impago", paid_at: null });
  }
  await snap(page, "pago-01-lista-impagas");
});

test("the row button marks one sale Pagada, and it stays after reloading", async ({ page, context }) => {
  await signIn(context, member);
  await page.goto(listUrl());
  const first = row(page, `FAC ${folio.inv1}`);
  await first.getByRole("button", { name: "Marcar pagada" }).click();
  await expect(first.getByText("Pagada", { exact: true })).toBeVisible();
  await expect(first.getByRole("button", { name: "Marcar impaga" })).toBeVisible();

  await page.reload();
  await expect(row(page, `FAC ${folio.inv1}`).getByText("Pagada", { exact: true })).toBeVisible();
  expect(await dbStatus(ids.inv1)).toEqual({ payment_status: "pagado", paid_at: null });
});

test("bulk: two sales marked Pagadas with a payment date, then Impagas clears the date", async ({ page, context }) => {
  await signIn(context, member);
  await page.goto(listUrl());

  const bar = page.locator(`form#sales-payment-bulk`);
  await page.getByRole("checkbox", { name: `Seleccionar FAC ${folio.inv2}` }).check();
  await page.getByRole("checkbox", { name: `Seleccionar FAC ${folio.inv3}` }).check();
  await expect(bar).toContainText("2 seleccionadas");
  await bar.getByLabel("Fecha de pago (opcional)").fill("1995-07-01");
  await bar.getByRole("button", { name: "Marcar pagadas" }).click();
  await expect(bar.getByRole("status")).toHaveText("2 ventas marcadas como pagadas");

  for (const number of [folio.inv2, folio.inv3]) {
    const r = row(page, `FAC ${number}`);
    await expect(r.getByText("Pagada", { exact: true })).toBeVisible();
    await expect(r).toContainText("01/07/1995");
  }
  expect(await dbStatus(ids.inv2)).toEqual({ payment_status: "pagado", paid_at: "1995-07-01" });
  expect(await dbStatus(ids.inv3)).toEqual({ payment_status: "pagado", paid_at: "1995-07-01" });
  await snap(page, "pago-02-masivo-pagadas");

  // The selection is cleared after a change; select again.
  await expect(bar).toContainText("Seleccioná ventas");
  await page.getByRole("checkbox", { name: `Seleccionar FAC ${folio.inv2}` }).check();
  await page.getByRole("checkbox", { name: `Seleccionar FAC ${folio.inv3}` }).check();
  await bar.getByRole("button", { name: "Marcar impagas" }).click();
  await expect(bar.getByRole("status")).toHaveText("2 ventas marcadas como impagas");
  expect(await dbStatus(ids.inv2)).toEqual({ payment_status: "impago", paid_at: null });
  expect(await dbStatus(ids.inv3)).toEqual({ payment_status: "impago", paid_at: null });
});

test("the Pagadas / Impagas filter shows only what matches", async ({ page, context }) => {
  await signIn(context, member);
  await page.goto(listUrl());

  await page.locator("#payment").selectOption("pagado");
  await page.getByRole("button", { name: "Filtrar" }).click();
  await expect(page).toHaveURL(/payment=pagado/);
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await expect(row(page, `FAC ${folio.inv1}`)).toHaveCount(1);
  await snap(page, "pago-03-filtro-pagadas");

  await page.locator("#payment").selectOption("impago");
  await page.getByRole("button", { name: "Filtrar" }).click();
  await expect(page).toHaveURL(/payment=impago/);
  await expect(page.locator("tbody tr")).toHaveCount(2);
  await expect(row(page, `FAC ${folio.inv2}`)).toHaveCount(1);
  await expect(row(page, `FAC ${folio.inv3}`)).toHaveCount(1);
  // A credit note has no payment status: it is in neither list.
  await expect(row(page, `N/C ${folio.nc}`)).toHaveCount(0);
});

test("the detail page changes status and date; the list then says Editado", async ({ page, context }) => {
  await signIn(context, member);
  await page.goto(`/companies/${ids.company}/sales/${ids.inv2}/edit`);
  await expect(page.getByRole("heading", { name: "Estado de pago" })).toBeVisible();
  await page.locator("#payment_status").selectOption("pagado");
  await page.locator("#paid_at").fill("1995-07-15");
  await page.getByRole("button", { name: "Guardar estado" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Guardado" })).toBeVisible();
  await snap(page, "pago-04-detalle");
  expect(await dbStatus(ids.inv2)).toEqual({ payment_status: "pagado", paid_at: "1995-07-15" });

  await page.goto(listUrl());
  const r = row(page, `FAC ${folio.inv2}`);
  await expect(r.getByText("Editado", { exact: true })).toBeVisible();
  await expect(r.getByText("Pagada", { exact: true })).toBeVisible();
  await expect(r).toContainText("15/07/1995");
});

test("a credit note neither shows nor changes a payment status", async ({ page, context }) => {
  await signIn(context, member);
  await page.goto(listUrl());
  const nc = row(page, `N/C ${folio.nc}`);
  await expect(nc).toHaveCount(1);
  await expect(nc.getByRole("checkbox")).toHaveCount(0);
  await expect(nc.getByRole("button", { name: /Marcar/ })).toHaveCount(0);
  await expect(nc.getByText(/^(Pagada|Impaga)$/)).toHaveCount(0);

  await page.goto(`/companies/${ids.company}/sales/${ids.nc}/edit`);
  await expect(page.getByRole("heading", { name: "Editar documento de venta" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Estado de pago" })).toHaveCount(0);
  await expect(page.locator("#payment_status")).toHaveCount(0);
});
