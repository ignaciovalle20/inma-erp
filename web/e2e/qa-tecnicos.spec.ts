/**
 * QA of 2026-10-27 (docs/qa-tecnicos-2026-10-27.md), on throwaway companies
 * "QA-…" in inma-erp-dev, everything deleted in afterAll:
 *  19. the board card indicators of the technicians (paid, sin respaldo,
 *      document pending);
 *  21. Uruguay: ficha without "Respaldo habitual" nor RUTs, cuenta corriente
 *      as before;
 *  22. the three allocation forms (Editar asignación, Asignar a servicios,
 *      Personal): save 3+ rows with different destinations, reload, edit,
 *      save again, reload -- what was saved is what is shown;
 *  23. at 390 px wide, the charge form with its live breakdown and the link
 *      screen have no horizontal scroll.
 * Run with `npm run test:e2e` after `npm run build`.
 */
import { expect, test, type Page } from "@playwright/test";
import {
  QA_PREFIX,
  admin,
  assertDev,
  createCompany,
  createMember,
  deleteCompanies,
  deleteUser,
  formatAmount,
  leftovers,
  newTag,
  ok,
  signIn,
  type Member,
} from "./helpers/devSession";

const tag = newTag(QA_PREFIX);
const ids = {
  cl: "",
  uy: "",
  client: "",
  area: "",
  jobs: [] as string[],
  uyJob: "",
  tech: "",
  techUy: "",
  supplier: "",
  doc: "",
  serviceDoc: "",
  periods: [] as string[],
  person: "",
  personCost: "",
  linkDoc: "",
  linkCharge: "",
};
let member: Member;

test.describe.configure({ mode: "serial" });

const jobName = (n: number) => `${tag} trabajo ${n}`;

test.beforeAll(async () => {
  assertDev();
  const db = admin();
  ids.cl = await createCompany(`${tag} CL`, "CL", "CLP");
  ids.uy = await createCompany(`${tag} UY`, "UY", "UYU");
  const client = await ok<{ id: string }>(db.from("clients").insert({ company_id: ids.cl, name: `${tag} cliente` }).select("id").single(), "client");
  const area = await ok<{ id: string }>(db.from("business_areas").insert({ company_id: ids.cl, name: `${tag} area` }).select("id").single(), "area");
  ids.client = client.id;
  ids.area = area.id;
  for (const n of [1, 2, 3, 4]) {
    const job = await ok<{ id: string }>(
      db.from("projects").insert({ company_id: ids.cl, client_id: client.id, business_area_id: area.id, name: jobName(n), status: "en_ejecucion" }).select("id").single(),
      `job ${n}`,
    );
    ids.jobs.push(job.id);
  }
  const uyClient = await ok<{ id: string }>(db.from("clients").insert({ company_id: ids.uy, name: `${tag} cliente UY` }).select("id").single(), "client UY");
  const uyArea = await ok<{ id: string }>(db.from("business_areas").insert({ company_id: ids.uy, name: `${tag} area UY` }).select("id").single(), "area UY");
  ids.uyJob = (
    await ok<{ id: string }>(
      db.from("projects").insert({ company_id: ids.uy, client_id: uyClient.id, business_area_id: uyArea.id, name: `${tag} trabajo UY`, status: "en_ejecucion" }).select("id").single(),
      "job UY",
    )
  ).id;
  member = await createMember(tag, [ids.cl, ids.uy]);

  // Technician with a RUT (its supplier is linked by itself).
  ids.tech = (
    await ok<{ id: string }>(
      member.client
        .from("personnel")
        .insert({ company_id: ids.cl, name: `${tag} Técnica`, type: "contractor", tax_id: "16.666.666-6", default_backing: "factura" })
        .select("id")
        .single(),
      "technician",
    )
  ).id;
  ids.supplier = (
    await ok<{ id: string }>(
      member.client.from("suppliers").insert({ company_id: ids.cl, name: `${tag} Técnica`, tax_id: "16666666-6" }).select("id").single(),
      "technician supplier",
    )
  ).id;
  ids.techUy = (
    await ok<{ id: string }>(
      member.client.from("personnel").insert({ company_id: ids.uy, name: `${tag} Técnico UY`, type: "contractor", payment_document: "factura" }).select("id").single(),
      "technician UY",
    )
  ).id;

  // A general cost for "Editar asignación".
  ids.doc = (
    await ok<{ id: string }>(
      member.client
        .rpc("create_cost_document", {
          p_company_id: ids.cl,
          p_supplier_id: null,
          p_project_id: null,
          p_classification: "general",
          p_document_date: "2026-10-05",
          p_currency: "CLP",
          p_tax_amount: 0,
          p_lines: [{ description: `${tag} gasto compartido`, amount: 300000 }],
        })
        .select()
        .single(),
      "general cost",
    )
  ).id;

  // Three recurring services of one supplier, and its invoice, for "Asignar a servicios".
  const starlink = await ok<{ id: string }>(db.from("suppliers").insert({ company_id: ids.cl, name: `${tag} Starlink` }).select("id").single(), "supplier");
  for (const n of [1, 2, 3]) {
    const service = await ok<{ id: string }>(
      member.client
        .from("recurring_services")
        .insert({
          company_id: ids.cl,
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
          supplier_id: starlink.id,
          status: "active",
          active: true,
        })
        .select("id")
        .single(),
      `service ${n}`,
    );
    ids.periods.push(
      (
        await ok<{ id: string }>(
          db.from("recurring_service_cost_periods").select("id").eq("recurring_service_id", service.id).eq("period", "2026-10-01").single(),
          `period ${n}`,
        )
      ).id,
    );
  }
  ids.serviceDoc = (
    await ok<{ id: string }>(
      member.client
        .rpc("create_cost_document", {
          p_company_id: ids.cl,
          p_supplier_id: starlink.id,
          p_project_id: null,
          p_classification: "general",
          p_document_date: "2026-10-05",
          p_currency: "CLP",
          p_tax_amount: 0,
          p_lines: [{ description: `${tag} Starlink octubre`, amount: 90000 }],
        })
        .select()
        .single(),
      "service invoice",
    )
  ).id;

  // An employee's monthly cost, for the Personal allocation.
  ids.person = (await ok<{ id: string }>(db.from("personnel").insert({ company_id: ids.cl, name: `${tag} Empleado`, type: "employee" }).select("id").single(), "employee")).id;
  ids.personCost = (
    await ok<{ id: string }>(
      db.from("personnel_costs").insert({ personnel_id: ids.person, period: "2026-10-01", amount: 300000, currency: "CLP" }).select("id").single(),
      "personnel cost",
    )
  ).id;
});

test.afterAll(async () => {
  const db = admin();
  if (member) {
    const linked = ((await db.from("technician_charge_documents").select("cost_document_id").eq("company_id", ids.cl)).data ?? []).map(
      (row) => row.cost_document_id as string,
    );
    for (const documentId of new Set(linked)) await member.client.rpc("unlink_technician_document", { p_cost_document_id: documentId });
  }
  if (ids.person) {
    await db.from("work_allocations").delete().eq("personnel_cost_id", ids.personCost);
    await db.from("personnel_costs").delete().eq("personnel_id", ids.person);
  }
  const failures = [...(await deleteCompanies([ids.cl, ids.uy].filter(Boolean))), ...(await deleteUser(member?.userId))];
  expect(failures).toEqual([]);
  expect(await leftovers(QA_PREFIX)).toEqual({ companies: 0, clients: 0, users: 0 });
});

function backedCharge(job: string, backing: string, enteredAs: string, value: number) {
  return ok<{ id: string; amount: number }>(
    member.client
      .rpc("create_backed_technician_charge", {
        p_project_id: job,
        p_personnel_id: ids.tech,
        p_description: `${tag} cargo`,
        p_charge_date: "2026-10-05",
        p_backing: backing,
        p_entered_as: enteredAs,
        p_value: value,
      })
      .single(),
    "charge",
  );
}

test("19. board cards: technician paid and sin respaldo; a pending factura says so", async ({ page, context }) => {
  const none = await backedCharge(ids.jobs[0], "none", "amount", 40000);
  await ok(
    member.client.rpc("record_technician_payment", {
      p_personnel_id: ids.tech,
      p_payment_date: "2026-10-06",
      p_amount: 40000,
      p_method: null,
      p_notes: null,
      p_applications: [{ charge_id: none.id, amount: 40000 }],
    }),
    "payment",
  );
  await backedCharge(ids.jobs[1], "factura", "net", 50000);

  await signIn(context, member);
  await page.goto(`/companies/${ids.cl}/projects/board`);
  const card = (n: number) => page.locator("li, article, div").filter({ hasText: jobName(n) }).filter({ has: page.getByText(/Técnico/) }).last();
  await expect(card(1)).toContainText("Técnico pagado");
  await expect(card(1)).toContainText("Sin respaldo");
  await expect(card(2)).toContainText("Técnico sin pagar");
  await expect(card(2)).toContainText("Documento pendiente");
  await page.screenshot({ path: test.info().outputPath("board.png"), fullPage: true });
});

test("21. Uruguay: ficha without backing nor RUTs, cuenta corriente and payments as before", async ({ page, context }) => {
  const charge = await ok<{ id: string }>(
    member.client
      .rpc("create_technician_charge", {
        p_project_id: ids.uyJob,
        p_personnel_id: ids.techUy,
        p_description: `${tag} visita`,
        p_charge_date: "2026-10-05",
        p_amount: 12200,
        p_vat_included: true,
        p_vat_rate: 0.22,
      })
      .single(),
    "UY charge",
  );
  await ok(
    member.client.rpc("record_technician_payment", {
      p_personnel_id: ids.techUy,
      p_payment_date: "2026-10-06",
      p_amount: 2200,
      p_method: "transferencia",
      p_notes: null,
      p_applications: [{ charge_id: charge.id, amount: 2200 }],
    }),
    "UY payment",
  );

  await signIn(context, member);
  await page.goto(`/companies/${ids.uy}/personnel/${ids.techUy}/edit`);
  await expect(page.getByText("Documento que emite")).toBeVisible();
  await expect(page.getByText("Respaldo habitual")).toHaveCount(0);
  await expect(page.getByText("RUT / proveedores vinculados")).toHaveCount(0);

  await page.goto(`/companies/${ids.uy}/personnel/${ids.techUy}/account`);
  await expect(page.getByText("Factura pendientes")).toBeVisible();
  await expect(page.getByText("Documentos recibidos")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Marcar factura recibida" })).toBeVisible();
  await expect(page.getByText("Pago parcial").first()).toBeVisible();
  await expect(page.getByText(formatAmount(10000, "UYU")).first()).toBeVisible();
});

test("22a. Editar asignación: three different destinations, reload, edit, save again", async ({ page, context }) => {
  await signIn(context, member);
  const open = async () => {
    await page.goto(`/companies/${ids.cl}/costs/${ids.doc}/allocate`);
    await expect(page.getByRole("heading", { name: "Editar asignación" })).toBeVisible();
  };
  const kind = (row: number) => page.locator('select[name="target_type"]').nth(row);
  const target = (row: number) => page.locator('select[name="target_id"]').nth(row);
  const save = async () => {
    await page.getByRole("button", { name: "Guardar asignación" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Asignación guardada." })).toBeVisible();
  };
  const expectRows = async (rows: [string, string][]) => {
    for (const [row, [type, id]] of rows.entries()) {
      await expect(kind(row)).toHaveValue(type);
      await expect(target(row)).toHaveValue(id);
    }
  };

  await open();
  await page.getByRole("button", { name: "+ Agregar destino" }).click();
  const first: [string, string][] = [
    ["project", ids.jobs[2]],
    ["client", ids.client],
    ["business_area", ids.area],
  ];
  for (const [row, [type, id]] of first.entries()) {
    await kind(row).selectOption(type);
    await target(row).selectOption(id);
  }
  await page.getByRole("button", { name: "Partes iguales" }).click();
  await save();
  await expectRows(first);

  await page.reload();
  await expectRows(first);
  // Edit: the job row goes to another job; saved again.
  await target(0).selectOption(ids.jobs[3]);
  await save();
  const second: [string, string][] = [["project", ids.jobs[3]], first[1], first[2]];
  await expectRows(second);
  await open();
  await expectRows(second);
  const saved = await ok<{ project_id: string | null; client_id: string | null; business_area_id: string | null; amount: number }[]>(
    admin().from("cost_allocations").select("project_id, client_id, business_area_id, amount").eq("cost_document_id", ids.doc).order("position"),
    "allocations",
  );
  expect(saved.map((row) => row.project_id ?? row.client_id ?? row.business_area_id)).toEqual(second.map(([, id]) => id));
  expect(saved.map((row) => Number(row.amount))).toEqual([100000, 100000, 100000]);
});

test("22b. Asignar a servicios: three services, reload, edit an amount, save again", async ({ page, context }) => {
  await signIn(context, member);
  const service = (row: number) => page.getByLabel("Servicio y período").nth(row);
  const amount = (row: number) => page.getByLabel("Monto").nth(row);
  const save = async () => {
    await page.getByRole("button", { name: "Guardar asignación a servicios" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Asignación a servicios guardada." })).toBeVisible();
  };
  const shown = async () => {
    const rows: string[] = [];
    for (const row of [0, 1, 2]) rows.push(`${await service(row).inputValue()} ${await amount(row).inputValue()}`);
    return rows.sort();
  };
  const expected = (amounts: number[]) => ids.periods.map((id, index) => `${id} ${formatAmount(amounts[index], "CLP")}`).sort();

  await page.goto(`/companies/${ids.cl}/costs/${ids.serviceDoc}/services`);
  await expect(page.getByRole("heading", { name: "Asignar a servicios" })).toBeVisible();
  while ((await page.getByRole("button", { name: "Quitar servicio" }).count()) > 0) {
    await page.getByRole("button", { name: "Quitar servicio" }).first().click();
  }
  const amounts = [30000, 30000, 30000];
  for (const row of [2, 0, 1]) {
    const index = (await page.getByRole("button", { name: "Quitar servicio" }).count());
    await page.getByRole("button", { name: "+ Agregar servicio" }).click();
    await service(index).selectOption(ids.periods[row]);
    await amount(index).pressSequentially(String(amounts[row]));
  }
  await save();
  expect(await shown()).toEqual(expected(amounts));

  await page.reload();
  expect(await shown()).toEqual(expected(amounts));
  // Edit: one service gets 20.000 (the invoice keeps 10.000 unallocated); saved again.
  const rowOf = async (periodId: string) => {
    for (const row of [0, 1, 2]) if ((await service(row).inputValue()) === periodId) return row;
    throw new Error("period not shown");
  };
  const edited = await rowOf(ids.periods[0]);
  await amount(edited).fill("");
  await amount(edited).pressSequentially("20000");
  await save();
  expect(await shown()).toEqual(expected([20000, 30000, 30000]));
  await page.reload();
  expect(await shown()).toEqual(expected([20000, 30000, 30000]));
});

test("22c. Personal: three allocations, reload, one more, reload", async ({ page, context }) => {
  await signIn(context, member);
  const project = page.getByLabel("Project");
  const amount = page.getByLabel("Amount (CLP)");
  const listed = page.getByRole("listitem");
  const add = async (job: number, value: number) => {
    await project.selectOption(ids.jobs[job]);
    await amount.pressSequentially(String(value));
    await page.getByRole("button", { name: "Add allocation" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Allocation saved." })).toBeVisible();
    await expect(project).toHaveValue("");
  };
  const expectListed = async (rows: [number, number][]) => {
    await expect(listed).toHaveCount(rows.length);
    for (const [index, [job, value]] of rows.entries()) {
      await expect(listed.nth(index)).toContainText(jobName(job + 1));
      await expect(listed.nth(index)).toContainText(`${formatAmount(value, "CLP")} CLP`);
    }
  };

  await page.goto(`/companies/${ids.cl}/personnel/${ids.person}/costs/${ids.personCost}/allocate`);
  const rows: [number, number][] = [
    [1, 100000],
    [2, 80000],
    [0, 50000],
  ];
  for (const [index, [job, value]] of rows.entries()) {
    await add(job, value);
    await expectListed(rows.slice(0, index + 1));
  }
  await page.reload();
  await expectListed(rows);
  await add(3, 20000);
  await expectListed([...rows, [3, 20000]]);
  await page.reload();
  await expectListed([...rows, [3, 20000]]);
});

async function expectNoHorizontalScroll(page: Page, what: string) {
  const { scroll, client } = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(scroll, `${what}: ${scroll}px de contenido en ${client}px`).toBeLessThanOrEqual(client);
}

test("23. at 390 px: the charge form, its breakdown and the link screen fit without horizontal scroll", async ({ page, context }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(context, member);

  await page.goto(`/companies/${ids.cl}/projects/${ids.jobs[2]}/technician-charges/new`);
  await page.locator("#personnel_id").selectOption(ids.tech);
  await page.locator("#backing").selectOption("boleta");
  await page.locator("#amount").fill("375.000");
  await expect(page.getByTestId("charge-breakdown")).toContainText("442.478");
  await expectNoHorizontalScroll(page, "cargo (boleta)");
  await page.locator("#backing").selectOption("factura");
  await page.locator("#amount").fill("1.000.001");
  await expect(page.getByTestId("charge-breakdown")).toContainText("1.190.001");
  await expectNoHorizontalScroll(page, "cargo (factura)");
  await page.screenshot({ path: test.info().outputPath("charge-390.png"), fullPage: true });

  const charge = await backedCharge(ids.jobs[2], "factura", "net", 100000);
  const batch = await ok<{ id: string }>(
    member.client.rpc("create_cost_import_batch", { p_company_id: ids.cl, p_file_name: `${tag}.csv`, p_total_rows: 1 }),
    "batch",
  );
  const [row] = await ok<{ cost_document_id: string }[]>(
    member.client.rpc("import_cost_rows_batch", {
      p_import_batch_id: batch.id,
      p_rows: [
        {
          row_number: 1,
          raw_data: { "Tipo documento": "FAC-EL", "Nº documento": "2301" },
          supplier_id: ids.supplier,
          document_date: "2026-10-20",
          currency: "CLP",
          amount: 100000,
          exempt_amount: 0,
          tax_amount: 19000,
          other_taxes: 0,
          document_type: "invoice",
          source_document_type: "FAC-EL",
          document_number: "2301",
          force: false,
          link_to_cost_document_id: null,
        },
      ],
    }),
    "import",
  );
  await page.goto(`/companies/${ids.cl}/costs/${row.cost_document_id}/technician?cargos=${charge.id}`);
  await expect(page.getByTestId("link-sum")).toContainText("Cuadra");
  await expectNoHorizontalScroll(page, "vínculo");
  await page.screenshot({ path: test.info().outputPath("link-390.png"), fullPage: true });

  await page.goto(`/companies/${ids.cl}/projects/${ids.jobs[2]}/technician-charges/${charge.id}/document`);
  await expect(page.getByText("FAC-EL 2301")).toBeVisible();
  await expectNoHorizontalScroll(page, "elegir documento");
});
