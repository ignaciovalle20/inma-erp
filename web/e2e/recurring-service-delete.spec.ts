/**
 * "Eliminar servicio" on a throwaway Chilean company in inma-erp-dev: off
 * (with what to remove) while a purchase invoice is assigned to the
 * service; on once it is removed, asks first, deletes the service with its
 * cycles and cost periods and goes back to the list. Run with
 * `npm run test:e2e` after `npm run build`.
 */
import { expect, test } from "@playwright/test";
import { admin, assertDev, createCompany, createMember, deleteCompanies, deleteUser, newTag, ok, signIn, type Member } from "./helpers/devSession";

const tag = newTag();
const ids = { cl: "", client: "", supplier: "", service: "", doc: "" };
let member: Member;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  assertDev();
  ids.cl = await createCompany(`${tag} Chile`, "CL", "CLP");
  member = await createMember(tag, [ids.cl]);
  const db = admin();
  ids.client = (await ok<{ id: string }>(db.from("clients").insert({ company_id: ids.cl, name: `${tag} cliente` }).select("id").single(), "client")).id;
  ids.supplier = (await ok<{ id: string }>(db.from("suppliers").insert({ company_id: ids.cl, name: `${tag} Starlink` }).select("id").single(), "supplier")).id;
  ids.service = (
    await ok<{ id: string }>(
      member.client
        .from("recurring_services")
        .insert({
          company_id: ids.cl,
          client_id: ids.client,
          name: `${tag} EBCO WIND`,
          currency: "CLP",
          reference_amount: 49990,
          periodicity: "monthly",
          invoicing_mode: "arrears",
          start_date: "2026-08-01",
          end_date: "2026-09-30",
          service_type: "starlink",
          fixed_cost: 31092,
          supplier_id: ids.supplier,
          status: "active",
          active: true,
        })
        .select("id")
        .single(),
      "service",
    )
  ).id;
  await ok(member.client.rpc("generate_recurring_service_occurrences_since_start", { p_service_id: ids.service, p_until: "2026-10-01" }), "cycles");
  const doc = await member.client
    .rpc("create_cost_document", {
      p_company_id: ids.cl,
      p_supplier_id: ids.supplier,
      p_project_id: null,
      p_classification: "general",
      p_document_date: "2026-08-20",
      p_currency: "CLP",
      p_tax_amount: 5907,
      p_lines: [{ description: `${tag} Starlink`, amount: 31092 }],
    })
    .select()
    .single<{ id: string }>();
  if (doc.error || !doc.data) throw new Error(JSON.stringify(doc.error));
  ids.doc = doc.data.id;
  const [period] = await ok<{ id: string }[]>(
    member.client.from("recurring_service_cost_periods").select("id").eq("recurring_service_id", ids.service).eq("period", "2026-08-01"),
    "cost period",
  );
  await ok(
    member.client.rpc("set_cost_service_allocations", { p_cost_document_id: ids.doc, p_allocations: [{ cost_period_id: period.id, amount: 31092 }] }),
    "allocation",
  );
});

test.afterAll(async () => {
  const failures = [...(await deleteCompanies([ids.cl].filter(Boolean))), ...(await deleteUser(member?.userId))];
  expect(failures).toEqual([]);
});

test("off while a purchase invoice is assigned, then deletes after confirming", async ({ page, context }) => {
  await signIn(context, member);
  const detail = `/companies/${ids.cl}/recurring-services/services/${ids.service}`;
  await page.goto(detail);
  const button = page.getByRole("button", { name: "Eliminar servicio" });
  await expect(button).toBeDisabled();
  await expect(page.getByText("Facturas de compra asignadas a sus períodos de costo")).toBeVisible();
  await expect(page.getByText(/del 20\/08\/2026 → costo de agosto 2026 \(confirmada\)/)).toBeVisible();

  await ok(member.client.rpc("set_cost_service_allocations", { p_cost_document_id: ids.doc, p_allocations: [] }), "remove allocation");
  await page.reload();
  await page.waitForLoadState("networkidle");
  await expect(button).toBeEnabled();
  await button.click();
  await expect(page.getByRole("alertdialog")).toContainText("Se borran el servicio y sus 2 ciclos y 2 períodos de costo");
  await page.getByRole("button", { name: "Cancelar" }).click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);

  await button.click();
  await page.getByRole("button", { name: "Sí, eliminar" }).click();
  await page.waitForURL(/recurring-services\/services\?eliminado=1/);
  await expect(page.getByText("Servicio eliminado, con sus ciclos y períodos de costo.")).toBeVisible();

  const db = admin();
  const count = async (table: string, column: string) =>
    (await db.from(table).select("id", { count: "exact", head: true }).eq(column, ids.service)).count;
  expect(await count("recurring_services", "id")).toBe(0);
  expect(await count("recurring_service_occurrences", "recurring_service_id")).toBe(0);
  expect(await count("recurring_service_cost_periods", "recurring_service_id")).toBe(0);
  const { count: docs } = await db.from("cost_documents").select("id", { count: "exact", head: true }).eq("id", ids.doc);
  expect(docs).toBe(1);
});
