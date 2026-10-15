/**
 * Multi-currency summaries (docs/cambios-pago-multimoneda-paridad-2026-10-14.md,
 * Tarea 2) in a throwaway Uruguayan company of inma-erp-dev: every summary
 * shows the subtotal of each currency in that currency and the combined
 * total in UYU and in USD, each document at the rate of its own date (the
 * month's snapshot or the nearest earlier one), and "incompleto" when a date
 * has no rate at all.
 *
 * Seeded (1995: no real snapshot exists that year; created and deleted here):
 *   UYU snapshots: March 40 UYU = 1 USD, May 50 UYU = 1 USD. No January
 *   (and nothing before), no April (falls back to March).
 *   CLP snapshot: March 1.000 CLP = 1 USD (for the Chilean company).
 *   UY sales: S1 USD 1.000 (10-03, job P) | S2 UYU 20.000 (15-04)
 *             S3 USD 500 (20-05)          | S4 UYU 10.000 (10-01, no rate)
 *             S5 USD 100 today (the home page shows the current month).
 *   UY costs: C1 USD 200 general (12-03) | C2 UYU 4.000 direct, job P (05-04)
 *   CL sales: CLP 1.000.000 (05-03) and CLP 500.000 (20-03).
 *   UY recurring services: USD 100 and UYU 4.000 a month, from this month.
 * Every expected figure is computed below from these numbers, never read
 * from the screen.
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
  lit,
  money,
  newTag,
  ok,
  seq,
  signIn,
  snap,
  type Member,
} from "./helpers/devSession";

const tag = newTag();
const ids = { uy: "", cl: "", uyClient: "", clClient: "", project: "", s1: "", s5: "" };
const uyName = `${tag} UY`;
const clName = `${tag} CL`;
let member: Member;
const today = new Date().toISOString().slice(0, 10);

// The seeded rates, in the shape of exchange_rate_snapshots.
const FX = [
  { currency: "UYU", period: "1995-03-01", ars_per_unit: 25, ars_per_usd: 1000 }, // 40 UYU / USD
  { currency: "UYU", period: "1995-05-01", ars_per_unit: 20, ars_per_usd: 1000 }, // 50 UYU / USD
  { currency: "CLP", period: "1995-03-01", ars_per_unit: 1, ars_per_usd: 1000 }, // 1.000 CLP / USD
];
const UYU_PER_USD = { mar: 40, apr: 40 /* no April snapshot: March */, may: 50 };

// Hand-computed figures (UYU local, USD).
const S = { s1: 1_000, s2: 20_000, s3: 500, s4: 10_000, s5: 100 };
const C = { c1: 200, c2: 4_000 };

test.describe.configure({ mode: "serial" });

async function sale(company: string, client: string, number: string, date: string, currency: string, net: number, projectId?: string) {
  const db = admin();
  let areaId: string | null = null;
  if (projectId) {
    areaId = (await ok<{ business_area_id: string }>(db.from("projects").select("business_area_id").eq("id", projectId).single(), "area")).business_area_id;
  }
  const row = await ok<{ id: string }>(
    db
      .from("sales_documents")
      .insert({
        company_id: company,
        client_id: client,
        project_id: projectId ?? null,
        business_area_id: areaId,
        document_type: "invoice",
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

async function cost(classification: "direct" | "general", projectId: string | null, date: string, currency: string, net: number) {
  const { error } = await member.client.rpc("create_cost_document", {
    p_company_id: ids.uy,
    p_supplier_id: null,
    p_project_id: projectId,
    p_classification: classification,
    p_document_date: date,
    p_currency: currency,
    p_tax_amount: 0,
    p_lines: [{ description: `${tag} costo`, amount: net }],
  });
  if (error) throw new Error(`cost: ${error.message}`);
}

/** USD per UYU on `date` from the real snapshots: that month's or the nearest earlier one. */
async function usdPerUyuOn(date: string): Promise<number> {
  const rows = await ok<{ ars_per_unit: number; ars_per_usd: number }[]>(
    admin()
      .from("exchange_rate_snapshots")
      .select("ars_per_unit, ars_per_usd")
      .eq("currency", "UYU")
      .lte("period", `${date.slice(0, 7)}-01`)
      .gt("ars_per_usd", 0)
      .order("period", { ascending: false })
      .limit(1),
    "snapshot",
  );
  if (rows.length === 0) throw new Error(`no UYU snapshot on or before ${date}`);
  return Number(rows[0].ars_per_unit) / Number(rows[0].ars_per_usd);
}

test.beforeAll(async () => {
  assertDev();
  const db = admin();
  const taken = await ok<unknown[]>(
    db.from("exchange_rate_snapshots").select("id").gte("period", "1995-01-01").lt("period", "1996-01-01"),
    "fx check",
  );
  if (taken.length > 0) throw new Error("1995 exchange-rate snapshots already exist: refusing to touch them");
  await ok(db.from("exchange_rate_snapshots").insert(FX).select("id"), "fx insert");

  ids.uy = await createCompany(uyName, "UY", "UYU");
  ids.cl = await createCompany(clName, "CL", "CLP");
  member = await createMember(tag, [ids.uy, ids.cl]);
  ids.uyClient = (await ok<{ id: string }>(db.from("clients").insert({ company_id: ids.uy, name: `${tag} cliente uy` }).select("id").single(), "client")).id;
  ids.clClient = (await ok<{ id: string }>(db.from("clients").insert({ company_id: ids.cl, name: `${tag} cliente cl` }).select("id").single(), "client")).id;

  const area = (await ok<{ id: string }[]>(db.from("business_areas").select("id").eq("company_id", ids.uy).limit(1), "areas"))[0];
  const { data: project, error } = await member.client.rpc("create_project_with_quote", {
    p_company_id: ids.uy,
    p_client_id: ids.uyClient,
    p_business_area_id: area.id,
    p_name: `${tag} trabajo P`,
    p_status: "en_ejecucion",
    p_quote_number: `${tag}-COT`,
    p_start_date: "1995-01-01",
    p_end_date: null,
    p_budget: null,
    p_responsible: null,
    p_invoiceable: true,
  });
  if (error) throw new Error(`project: ${error.message}`);
  ids.project = (project as { id: string }).id;

  ids.s1 = await sale(ids.uy, ids.uyClient, `${tag}-S1`, "1995-03-10", "USD", S.s1, ids.project);
  await sale(ids.uy, ids.uyClient, `${tag}-S2`, "1995-04-15", "UYU", S.s2);
  await sale(ids.uy, ids.uyClient, `${tag}-S3`, "1995-05-20", "USD", S.s3);
  await sale(ids.uy, ids.uyClient, `${tag}-S4`, "1995-01-10", "UYU", S.s4);
  ids.s5 = await sale(ids.uy, ids.uyClient, `${tag}-S5`, today, "USD", S.s5);
  await sale(ids.cl, ids.clClient, `${tag}-CL1`, "1995-03-05", "CLP", 1_000_000);
  await sale(ids.cl, ids.clClient, `${tag}-CL2`, "1995-03-20", "CLP", 500_000);
  await cost("general", null, "1995-03-12", "USD", C.c1);
  await cost("direct", ids.project, "1995-04-05", "UYU", C.c2);

  for (const [name, currency, price] of [["usd", "USD", 100], ["uyu", "UYU", 4_000]] as const) {
    await ok(
      db
        .from("recurring_services")
        .insert({
          company_id: ids.uy,
          client_id: ids.uyClient,
          name: `${tag} servicio ${name}`,
          price,
          currency,
          periodicity: "monthly",
          invoicing_mode: "advance",
          due_day: 5,
          service_type: "hosting",
          start_date: `${today.slice(0, 7)}-01`,
        })
        .select("id"),
      `service ${name}`,
    );
  }
});

test.afterAll(async () => {
  const failures = [...(await deleteCompanies([ids.uy, ids.cl].filter(Boolean))), ...(await deleteUser(member?.userId))];
  const { error } = await admin().from("exchange_rate_snapshots").delete().gte("period", "1995-01-01").lt("period", "1996-01-01");
  if (error) failures.push(`fx: ${error.message}`);
  expect(failures).toEqual([]);
});

/** The innermost element whose text starts with `label` and holds a total (a summary card). */
const card = (page: Page, label: string, holds = "Total combinado") =>
  page
    .locator("main div")
    .filter({ hasText: new RegExp(`^${lit(label)}`) })
    .filter({ hasText: holds })
    .last();

test("Ventas: subtotal per currency, combined total in UYU and USD, nearest earlier rate, incompleto", async ({ page, context }) => {
  await signIn(context, member);
  // S5's own stored rate (today's snapshot when it was created).
  const s5 = await ok<{ exchange_rate: number }>(admin().from("sales_documents").select("exchange_rate").eq("id", ids.s5).single(), "s5");
  const s5Local = S.s5 * Number(s5.exchange_rate);

  await page.goto(`/companies/${ids.uy}/sales?period=all`);
  const usd = S.s1 + S.s3 + S.s5;
  const uyu = S.s2 + S.s4;
  const local = S.s1 * UYU_PER_USD.mar + S.s2 + S.s3 * UYU_PER_USD.may + S.s4 + s5Local;
  // S4 (January) has no rate on or before its date: left out of USD.
  const totalUsd = S.s1 + S.s2 / UYU_PER_USD.apr + S.s3 + S.s5;
  const total = card(page, "Total del historial · neto sin IVA");
  await expect(total).toContainText(seq("Neto USD", money(usd, "USD")));
  await expect(total).toContainText(seq("Neto UYU", money(uyu, "UYU")));
  await expect(total).toContainText(seq("Total combinado", money(local, "UYU"), money(totalUsd, "USD"), "incompleto"));
  await expect(total.getByText("incompleto")).toHaveCount(1);
  await snap(page, "multi-01-ventas-historial");

  // April alone: S2 at March's rate (no April snapshot).
  await page.goto(`/companies/${ids.uy}/sales?period=1995-04`);
  const april = card(page, "Facturado · neto sin IVA");
  await expect(april).toContainText(seq("Facturado UYU", money(S.s2, "UYU")));
  await expect(april).toContainText(seq("Total combinado", money(S.s2, "UYU"), money(S.s2 / 40, "USD")));
  await expect(april.getByText("incompleto")).toHaveCount(0);

  // January alone: no rate at all -> USD incompleto, UYU complete.
  await page.goto(`/companies/${ids.uy}/sales?period=1995-01`);
  const january = card(page, "Facturado · neto sin IVA");
  await expect(january).toContainText(seq("Total combinado", money(S.s4, "UYU"), money(0, "USD"), "incompleto"));
  await snap(page, "multi-02-ventas-enero-incompleto");
});

test("Ventas: the per-row cost and profit are in UYU, never USD minus UYU", async ({ page, context }) => {
  await signIn(context, member);
  await page.goto(`/companies/${ids.uy}/sales?period=1995-03`);
  await expect(page.locator("thead")).toContainText("Gasto (UYU)");
  const row = page.locator("tbody tr").filter({ hasText: `${tag}-S1` });
  // Job P: revenue S1 = 1.000 USD x 40 = 40.000 UYU, cost C2 = 4.000 UYU.
  const net = S.s1 * UYU_PER_USD.mar;
  const cells = row.locator("td");
  await expect(row).toContainText(seq(money(S.s1, "USD")));
  await expect(cells.nth(7)).toHaveText(formatAmount(C.c2, "UYU"));
  await expect(cells.nth(8)).toHaveText(formatAmount(net - C.c2, "UYU"));
  await expect(cells.nth(9)).toHaveText(`${(((net - C.c2) / net) * 100).toFixed(0)}%`);
  await snap(page, "multi-03-ventas-gasto-por-fila");
});

test("Gastos: per currency and combined, with the nearest earlier rate", async ({ page, context }) => {
  await signIn(context, member);
  await page.goto(`/companies/${ids.uy}/costs?period=all`);
  const total = card(page, "Total del historial · neto sin IVA");
  await expect(total).toContainText(seq("Gastado USD", money(C.c1, "USD")));
  await expect(total).toContainText(seq("Gastado UYU", money(C.c2, "UYU")));
  // C1 at March's 40; C2 (April) at March's 40 too.
  await expect(total).toContainText(
    seq("Total combinado", money(C.c1 * 40 + C.c2, "UYU"), money(C.c1 + C.c2 / UYU_PER_USD.apr, "USD")),
  );
  await expect(card(page, "Directos · neto sin IVA")).toContainText(seq("Total combinado", money(C.c2, "UYU"), money(C.c2 / 40, "USD")));
  await expect(card(page, "Generales · neto sin IVA")).toContainText(seq("Total combinado", money(C.c1 * 40, "UYU"), money(C.c1, "USD")));
  await snap(page, "multi-04-gastos");
});

test("Dashboard: KPIs of April with USD at March's rate", async ({ page, context }) => {
  await signIn(context, member);
  await page.goto(`/companies/${ids.uy}?period=1995-04`);
  const kpi = (label: string) =>
    page.locator("main .surface-card").filter({ has: page.locator("span.caps-label", { hasText: new RegExp(`^${label}$`) }) });
  const rate = UYU_PER_USD.apr;
  await expect(kpi("Ventas netas")).toContainText(seq(money(S.s2, "UYU"), "Total", money(S.s2 / rate, "USD")));
  await expect(kpi("Costos directos")).toContainText(seq(money(C.c2, "UYU"), "Total", money(C.c2 / rate, "USD")));
  await expect(kpi("Margen directo")).toContainText(seq(money(S.s2 - C.c2, "UYU"), "Total", money((S.s2 - C.c2) / rate, "USD")));
  await expect(kpi("Resultado operativo")).toContainText(seq(money(S.s2 - C.c2, "UYU"), "Total", money((S.s2 - C.c2) / rate, "USD")));
  await snap(page, "multi-05-dashboard-abril");
});

test("Resultado mensual: per currency and both totals; January incompleto", async ({ page, context }) => {
  await signIn(context, member);
  await page.goto(`/companies/${ids.uy}/reports/monthly-result?period=1995-03`);
  const main = page.locator("main");
  const sales = S.s1 * 40;
  const general = C.c1 * 40;
  await expect(main).toContainText(seq("Ventas netas", "100%", money(sales, "UYU"), money(S.s1, "USD"), "Total:", money(sales, "UYU"), money(S.s1, "USD")));
  await expect(main).toContainText(seq("Costos generales", "\\d+%", money(general, "UYU"), money(C.c1, "USD"), "Total:", money(general, "UYU"), money(C.c1, "USD")));
  await expect(main).toContainText(
    seq("Resultado operativo", "Margen directo menos costos generales del período.", money(sales - general, "UYU"), money(S.s1 - C.c1, "USD"), "Total:", money(sales - general, "UYU"), money(S.s1 - C.c1, "USD")),
  );
  await snap(page, "multi-06-resultado-marzo");

  await page.goto(`/companies/${ids.uy}/reports/monthly-result?period=1995-01`);
  await expect(page.locator("main")).toContainText(seq("Ventas netas", "100%", money(S.s4, "UYU"), "Total:", money(S.s4, "UYU"), money(0, "USD"), "incompleto"));
  await snap(page, "multi-07-resultado-enero-incompleto");
});

test("Rentabilidad: the month's totals per currency and combined", async ({ page, context }) => {
  await signIn(context, member);
  await page.goto(`/companies/${ids.uy}/reports/profitability?period=1995-03`);
  await expect(card(page, "Ventas netas del mes", "En USD")).toContainText(
    seq("En USD", money(S.s1, "USD"), "Total", money(S.s1 * 40, "UYU"), money(S.s1, "USD")),
  );
  await expect(page.locator("main")).toContainText("Montos netos (sin IVA). Las tablas están en UYU");
  await snap(page, "multi-08-rentabilidad");
});

test("Consolidado USD: each company converted document by document; incompleto excluded", async ({ page, context }) => {
  await signIn(context, member);
  await page.goto(`/reports/consolidated?period=1995-03`);
  const company = (name: string) => page.locator("main .surface-card").filter({ hasText: name });
  const uyUsd = S.s1 - C.c1;
  const clUsd = (1_000_000 + 500_000) / 1_000;
  await expect(company(uyName)).toContainText(seq("Resultado operativo en USD", money(uyUsd, "USD")));
  await expect(company(clName)).toContainText(seq("Resultado operativo en USD", money(clUsd, "USD")));
  await expect(page.locator("main")).toContainText(seq("Total \\(USD\\)", money(uyUsd + clUsd, "USD")));
  await snap(page, "multi-09-consolidado-marzo");

  await page.goto(`/reports/consolidated?period=1995-01`);
  await expect(company(uyName)).toContainText("Tipo de cambio pendiente");
  await expect(company(uyName)).toContainText("incompleto");
  await expect(page.locator("main")).toContainText(`El total excluye a ${uyName}`);
});

test("Inicio: this month's result of each company, with its USD equivalent", async ({ page, context }) => {
  await signIn(context, member);
  const s5 = await ok<{ exchange_rate: number }>(admin().from("sales_documents").select("exchange_rate").eq("id", ids.s5).single(), "s5");
  await page.goto(`/`);
  const uy = page.getByRole("link").filter({ hasText: uyName });
  await expect(uy).toContainText(seq(money(S.s5 * Number(s5.exchange_rate), "UYU"), "≈:", money(S.s5, "USD")));
  await expect(page.getByRole("link").filter({ hasText: clName })).toContainText(new RegExp(money(0, "CLP")));
  await snap(page, "multi-10-inicio");
});

test("Servicios recurrentes: combined total of USD and UYU cycles", async ({ page, context }) => {
  await signIn(context, member);
  await page.goto(`/companies/${ids.uy}/recurring-services`);
  const cycles = await ok<{ amount: number; currency: string; invoice_due_date: string | null; period: string }[]>(
    admin()
      .from("recurring_service_occurrences")
      .select("amount, currency, invoice_due_date, period, recurring_services!inner(company_id)")
      .eq("recurring_services.company_id", ids.uy)
      .eq("period", `${today.slice(0, 7)}-01`),
    "cycles",
  );
  expect(cycles.map((c) => c.currency).sort()).toEqual(["USD", "UYU"]);
  let local = 0;
  let usd = 0;
  for (const cycle of cycles) {
    const rate = await usdPerUyuOn(cycle.invoice_due_date ?? cycle.period);
    const amount = Number(cycle.amount);
    local += cycle.currency === "UYU" ? amount : (amount * 1) / rate;
    usd += cycle.currency === "USD" ? amount : amount * rate;
  }
  const box = page.locator("main div").filter({ hasText: /^Total combinado · UYU y USD/ }).last();
  await expect(box).toContainText(seq("Por facturar", money(local, "UYU"), money(usd, "USD")));
  // A combined line has no empty "label:" before the amounts.
  await expect(box).not.toContainText("Por facturar:");
  // The per-currency cards are still there, each in its own currency.
  await expect(page.locator("main")).toContainText(seq(lit("· USD"), "Por facturar", lit("100,00")));
  await expect(page.locator("main")).toContainText(seq(lit("· UYU"), "Por facturar", lit("4.000,00")));
  await snap(page, "multi-11-recurrentes");
});
