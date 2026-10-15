/**
 * The generic sales importer for every company
 * (docs/cambios-pago-multimoneda-paridad-2026-10-14.md, Tarea 3): a CSV and
 * an .xlsx built here, with column names nobody would guess, are mapped by
 * hand, previewed and imported into a throwaway Uruguayan company; a second
 * import of the same file creates nothing; the file's payment status
 * overwrites one changed by hand; in Chile the same importer is there, a
 * USD row is refused, and the Nubox tab is only offered in Chile. Every
 * result is checked in the database.
 */
import ExcelJS from "exceljs";
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
const ids = { uy: "", cl: "" };
let member: Member;
const clientName = `${tag} cliente`;
const newClientName = `${tag} cliente nuevo`;

test.describe.configure({ mode: "serial" });

// Column names nobody would map automatically.
const HEADERS = ["F. emisión", "Nro Factura", "Razón social", "Importe s/IVA", "Divisa", "IVA $", "Situación", "Cobrada el"];
const MAPPING: [string, string][] = [
  ["Fecha", "F. emisión"],
  ["N° de documento / folio", "Nro Factura"],
  ["Cliente", "Razón social"],
  ["Monto neto (sin IVA)", "Importe s/IVA"],
  ["Moneda", "Divisa"],
  ["IVA", "IVA $"],
  ["Estado de pago", "Situación"],
  ["Fecha de pago", "Cobrada el"],
];

type Line = { date: string; folio: string; client: string; net: number; currency: string; vat: number | null; status: string; paidAt: string | null };
const UY_LINES: Line[] = [
  { date: "1995-02-05", folio: `${tag}-U1`, client: clientName, net: 1500.5, currency: "US$", vat: 0, status: "Pagada", paidAt: "1995-02-10" },
  { date: "1995-02-06", folio: `${tag}-U2`, client: clientName, net: 20000, currency: "UYU", vat: 4400, status: "Impaga", paidAt: null },
  { date: "1995-02-07", folio: `${tag}-U3`, client: newClientName, net: 300, currency: "USD", vat: null, status: "Pendiente", paidAt: null },
];

const dmy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
/** "1500.5" -> "1.500,50", the way a Uruguayan spreadsheet exports it. */
const localAmount = (value: number) => value.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function csv(lines: Line[]): Buffer {
  const cell = (value: string) => `"${value.replace(/"/g, '""')}"`;
  const rows = lines.map((line) =>
    [dmy(line.date), line.folio, line.client, localAmount(line.net), line.currency, line.vat === null ? "" : localAmount(line.vat), line.status, line.paidAt ? dmy(line.paidAt) : ""]
      .map(cell)
      .join(";"),
  );
  return Buffer.from(`﻿${[HEADERS.map(cell).join(";"), ...rows].join("\r\n")}\r\n`, "utf8");
}

async function xlsx(lines: Line[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Facturas");
  sheet.addRow(HEADERS);
  for (const line of lines) {
    sheet.addRow([
      new Date(`${line.date}T00:00:00Z`),
      line.folio,
      line.client,
      line.net,
      line.currency,
      line.vat,
      line.status,
      line.paidAt ? new Date(`${line.paidAt}T00:00:00Z`) : null,
    ]);
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function upload(page: Page, name: string, mimeType: string, buffer: Buffer, mapping: [string, string][] = MAPPING) {
  // The file input reacts only once the form is hydrated.
  await page.waitForLoadState("networkidle");
  await page.locator("#file").setInputFiles({ name, mimeType, buffer });
  await expect(page.getByText(name)).toBeVisible();
  for (const [field, column] of mapping) {
    await page.getByLabel(`Columna para ${field}`, { exact: true }).selectOption(column);
  }
  await page.getByRole("button", { name: "Previsualizar" }).click();
}

type Stored = { document_number: string; document_type: string; currency: string; net_amount: number; tax_amount: number; payment_status: string; paid_at: string | null; clients: { name: string } };

async function stored(companyId: string): Promise<Stored[]> {
  const rows = await ok<Stored[]>(
    admin()
      .from("sales_documents")
      .select("document_number, document_type, currency, net_amount, tax_amount, payment_status, paid_at, clients(name)")
      .eq("company_id", companyId)
      .order("document_number"),
    "stored",
  );
  return rows.map((row) => ({ ...row, net_amount: Number(row.net_amount), tax_amount: Number(row.tax_amount) }));
}

test.beforeAll(async () => {
  assertDev();
  const db = admin();
  ids.uy = await createCompany(`${tag} UY`, "UY", "UYU");
  ids.cl = await createCompany(`${tag} CL`, "CL", "CLP");
  await ok(db.from("clients").insert([{ company_id: ids.uy, name: clientName }, { company_id: ids.cl, name: clientName }]).select("id"), "clients");
  member = await createMember(tag, [ids.uy, ids.cl]);
});

test.afterAll(async () => {
  const failures = [...(await deleteCompanies([ids.uy, ids.cl].filter(Boolean))), ...(await deleteUser(member?.userId))];
  expect(failures).toEqual([]);
});

const EXPECTED_UY = (u2Status: "pagado" | "impago") => [
  { document_number: `${tag}-U1`, document_type: "invoice", currency: "USD", net_amount: 1500.5, tax_amount: 0, payment_status: "pagado", paid_at: "1995-02-10", clients: { name: clientName } },
  { document_number: `${tag}-U2`, document_type: "invoice", currency: "UYU", net_amount: 20000, tax_amount: 4400, payment_status: u2Status, paid_at: null, clients: { name: clientName } },
  { document_number: `${tag}-U3`, document_type: "invoice", currency: "USD", net_amount: 300, tax_amount: 0, payment_status: "impago", paid_at: null, clients: { name: newClientName } },
];

test("UY: an .xlsx with unusual columns is mapped, previewed and imported", async ({ page, context }) => {
  await signIn(context, member);
  await page.goto(`/companies/${ids.uy}/sales`);
  await page.getByRole("link", { name: "Importar", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/companies/${ids.uy}/sales/import`));
  // Uruguay has the generic importer only: no Nubox tab.
  await expect(page.getByRole("link", { name: "Nubox" })).toHaveCount(0);

  await upload(page, "ventas-uy.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", await xlsx(UY_LINES));
  const preview = page.locator("table");
  await expect(preview).toContainText(`${tag}-U1`);
  await expect(preview.locator("tbody tr")).toHaveCount(3);
  await expect(preview.locator("tbody tr").nth(0)).toContainText("USD");
  await expect(preview.locator("tbody tr").nth(0)).toContainText("Pagada");
  await expect(preview.locator("tbody tr").nth(2)).toContainText("Cliente nuevo");
  await snap(page, "import-01-uy-preview-xlsx");
  await page.getByRole("button", { name: "Importar 3 filas" }).click();
  await expect(page.getByText("Importación completa")).toBeVisible();
  await expect(page.getByText(/3 de 3 filas importadas/)).toBeVisible();
  await snap(page, "import-02-uy-resultado");

  expect(await stored(ids.uy)).toEqual(EXPECTED_UY("impago"));
});

test("UY: importing the same file again (as CSV) creates nothing", async ({ page, context }) => {
  await signIn(context, member);
  await page.goto(`/companies/${ids.uy}/sales/import`);
  await upload(page, "ventas-uy.csv", "text/csv", csv(UY_LINES));
  const rows = page.locator("table tbody tr");
  await expect(rows).toHaveCount(3);
  for (let i = 0; i < 3; i += 1) await expect(rows.nth(i)).toContainText("Ya existe");
  await snap(page, "import-03-uy-reimport-preview");
  await page.getByRole("button", { name: "Importar 0 filas" }).click();
  await expect(page.getByText(/0 de 3 filas importadas/)).toBeVisible();
  await expect(page.getByText(/3 filas omitidas porque ya existían/)).toBeVisible();

  expect(await stored(ids.uy)).toEqual(EXPECTED_UY("impago"));
});

test("UY: the file's payment status overwrites one changed by hand", async ({ page, context }) => {
  await signIn(context, member);
  await page.goto(`/companies/${ids.uy}/sales?period=all`);
  const row = page.locator("tbody tr").filter({ hasText: `${tag}-U2` });
  await row.getByRole("button", { name: "Marcar pagada" }).click();
  await expect(row.getByText("Pagada", { exact: true })).toBeVisible();
  expect(await stored(ids.uy)).toEqual(EXPECTED_UY("pagado"));

  await page.goto(`/companies/${ids.uy}/sales/import`);
  await upload(page, "ventas-uy.csv", "text/csv", csv(UY_LINES));
  await page.getByRole("button", { name: "Importar 0 filas" }).click();
  await expect(page.getByText(/1 documento existente con el estado de pago actualizado/)).toBeVisible();
  expect(await stored(ids.uy)).toEqual(EXPECTED_UY("impago"));
});

test("CL: the generic importer is there, CLP is fixed, a USD row is refused; Nubox only in Chile", async ({ page, context }) => {
  await signIn(context, member);
  await page.goto(`/companies/${ids.cl}/sales/import`);
  await expect(page.getByRole("link", { name: "Nubox" })).toBeVisible();
  await page.getByRole("link", { name: "CSV / Excel (con mapeo)" }).click();
  await expect(page).toHaveURL(/modo=csv/);

  const lines: Line[] = [
    { date: "1995-02-08", folio: `${tag}-C1`, client: clientName, net: 100000, currency: "CLP", vat: 19000, status: "Pagada", paidAt: null },
    { date: "1995-02-09", folio: `${tag}-C2`, client: clientName, net: 500, currency: "USD", vat: 0, status: "Impaga", paidAt: null },
  ];
  await page.waitForLoadState("networkidle");
  await page.locator("#file").setInputFiles({ name: "ventas-cl.csv", mimeType: "text/csv", buffer: csv(lines) });
  await expect(page.getByText("Moneda: todo se importa en CLP")).toBeVisible();
  for (const [field, column] of MAPPING) {
    await page.getByLabel(`Columna para ${field}`, { exact: true }).selectOption(column);
  }
  await page.getByRole("button", { name: "Previsualizar" }).click();
  const rows = page.locator("table tbody tr");
  await expect(rows.nth(1)).toContainText("esta empresa solo usa CLP (la fila dice USD)");
  await snap(page, "import-04-cl-preview");
  await page.getByRole("button", { name: "Importar 1 filas" }).click();
  await expect(page.getByText(/1 de 2 filas importadas/)).toBeVisible();
  await expect(page.getByText(/Fila 2: Moneda inválida/)).toBeVisible();

  const rowsCl = await stored(ids.cl);
  expect(rowsCl.map(({ document_number, currency, net_amount, payment_status }) => ({ document_number, currency, net_amount, payment_status }))).toEqual([
    { document_number: `${tag}-C1`, currency: "CLP", net_amount: 100000, payment_status: "pagado" },
  ]);

  // Uruguay asking for the Nubox tab gets the generic importer.
  await page.goto(`/companies/${ids.uy}/sales/import?modo=nubox`);
  await expect(page.getByText("Archivo CSV o Excel (.xlsx)")).toBeVisible();
  await expect(page.getByRole("link", { name: "Nubox" })).toHaveCount(0);
});
