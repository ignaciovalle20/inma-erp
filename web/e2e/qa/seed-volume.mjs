// QA volume data (~300 projects) for inma-erp-dev ONLY -- see README.md.
//   QA_VOLUME=1 node e2e/qa/seed-volume.mjs seed      creates it, state in e2e/qa/.qa-state.json
//   QA_VOLUME=1 node e2e/qa/seed-volume.mjs cleanup   deletes everything named zz-qa-*
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import nextEnv from "@next/env";
import { createClient } from "@supabase/supabase-js";

const here = path.dirname(fileURLToPath(import.meta.url));
nextEnv.loadEnvConfig(path.resolve(here, "..", ".."));

if (process.env.QA_VOLUME !== "1") {
  console.error("QA volume data is opt-in: set QA_VOLUME=1.");
  process.exit(1);
}

// Never anything but inma-erp-dev: abort before creating a client.
const DEV_REF = "sczgankronafrxybpvnh";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
let host = "";
try {
  host = new URL(url).host;
} catch {
  // empty or malformed URL: host stays "" and the check below aborts
}
if (host !== `${DEV_REF}.supabase.co`) {
  console.error(`Aborted: NEXT_PUBLIC_SUPABASE_URL is not inma-erp-dev (${DEV_REF}), got "${host}".`);
  process.exit(1);
}
const db = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const STATE = process.env.QA_STATE || path.join(here, ".qa-state.json");

async function ok(promise, label) {
  const { data, error } = await promise;
  if (error) throw new Error(`${label}: ${error.message}`);
  return data;
}

async function createUser(email, fullName) {
  const password = randomBytes(24).toString("base64url");
  const data = await ok(
    db.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: fullName ? { full_name: fullName } : undefined,
    }),
    `user ${email}`,
  );
  return { id: data.user.id, email, password };
}

// Deterministic pseudo-random.
let seed = 42;
function rnd() {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
}
const pick = (list) => list[Math.floor(rnd() * list.length)];

const CLIENTS = [
  "Constructora Peñalolén",
  "Óptica Ñuñoa",
  "Muñoz & Hijos",
  "José Ángel Pérez",
  "Cliente 100% Real",
  "O'Higgins Ltda",
  'Distribuidora "El Sol"',
  "Under_score SpA",
  "Agrícola San José",
  "Agricola San Jose",
  "Agrícola San José Ltda",
  "Pingüino Frío S.A.",
  "Café Ñandú",
  "Inversiones Ébano",
  "Transportes Ñirehuao",
  "Comercializadora Internacional de Productos Tecnológicos y Servicios Integrales del Pacífico Sur Limitada",
];
const ALIASES = [
  ["Constructora Peñalolén", "PEÑALOLEN CONSTRUCTORA S.A."],
  ["Óptica Ñuñoa", "Opticas Nunoa SpA"],
  ["Pingüino Frío S.A.", "PINGUINO FRIO"],
  ["Café Ñandú", "Cafetería del Ñandú"],
];
const STATUSES = ["por_cotizar", "en_ejecucion", "en_espera", "finalizado", "cerrado", "cancelado"];
const WORDS = [
  "Instalación cámaras",
  "Cableado red",
  "Mantención servidor",
  "Migración correo",
  "Soporte anual",
  "Enlace fibra",
  "Paneles solares",
  "Licencias Microsoft",
  "Respaldo nube",
  "Alarma bodega",
];

async function seedAll() {
  const tag = `zz-qa-${randomUUID().slice(0, 8)}`;
  const state = { tag, companies: [], users: [], projects: {} };
  const save = () => writeFileSync(STATE, JSON.stringify(state, null, 2));

  const [company, otherCompany] = await ok(
    db
      .from("companies")
      .insert([
        { name: `${tag} Ñandú Cía QA`, country: "CL", tax_id: "11.111.111-1", currency: "CLP", management_start_date: "2025-01-01" },
        { name: `${tag} Otra Empresa`, country: "UY", tax_id: "219999999999", currency: "UYU" },
      ])
      .select("id"),
    "companies",
  );
  state.companies = [company.id, otherCompany.id];
  save();

  const owner = await createUser(`${tag}-owner@example.test`, "Dueña QA Ñúñez");
  const second = await createUser(`${tag}-second@example.test`, "Segundo Miembro QA");
  const outsider = await createUser(`${tag}-outsider@example.test`, null);
  state.users = [owner, second, outsider];
  state.owner = owner;
  state.second = second;
  state.outsider = outsider;
  state.companyId = company.id;
  state.otherCompanyId = otherCompany.id;
  save();

  await ok(
    db.from("company_memberships").insert([
      { user_id: owner.id, company_id: company.id, role: "admin" },
      { user_id: outsider.id, company_id: otherCompany.id, role: "admin" },
    ]),
    "memberships",
  );

  const areas = await ok(db.from("business_areas").select("id, name").eq("company_id", company.id), "areas");
  if (areas.length === 0) throw new Error("no business areas seeded");

  const clients = await ok(
    db
      .from("clients")
      .insert(CLIENTS.map((name) => ({ company_id: company.id, name, country: "CL" })))
      .select("id, name"),
    "clients",
  );
  const clientByName = new Map(clients.map((c) => [c.name, c.id]));
  await ok(
    db.from("client_aliases").insert(
      ALIASES.map(([client, external]) => ({
        company_id: company.id,
        client_id: clientByName.get(client),
        external_name: external,
      })),
    ),
    "aliases",
  );
  // A client in the other company with the same name: must never leak.
  const [otherClient] = await ok(
    db.from("clients").insert({ company_id: otherCompany.id, name: "Constructora Peñalolén", country: "UY" }).select("id"),
    "other client",
  );
  const otherAreas = await ok(db.from("business_areas").select("id").eq("company_id", otherCompany.id), "other areas");
  const [otherProject] = await ok(
    db
      .from("projects")
      .insert({
        company_id: otherCompany.id,
        client_id: otherClient.id,
        business_area_id: otherAreas[0].id,
        name: "Proyecto secreto de la otra empresa",
        status: "en_ejecucion",
      })
      .select("id"),
    "other project",
  );
  state.otherProjectId = otherProject.id;

  // Special projects first (fixed names the tests look for).
  const special = [
    { key: "accents", name: "Instalación cámaras Peñalolén", status: "en_ejecucion", client: "Constructora Peñalolén" },
    { key: "accentsTwin", name: "Instalacion camaras Penalolen", status: "en_ejecucion", client: "Agricola San Jose" },
    { key: "percent", name: "Proyecto 50% descuento", status: "en_ejecucion", client: "Cliente 100% Real" },
    { key: "underscore", name: "Proyecto under_score", status: "por_cotizar", client: "Under_score SpA" },
    { key: "quote", name: "Proyecto O'Brien", status: "en_espera", client: "O'Higgins Ltda", hold_reason: "Esperando OC" },
    { key: "dquote", name: 'Proyecto "comillas" dobles', status: "en_ejecucion", client: 'Distribuidora "El Sol"' },
    {
      key: "long",
      name: `Proyecto con un nombre larguísimo ${"de prueba para ver cómo se corta en la tabla y en el detalle ".repeat(3)}fin`,
      status: "en_ejecucion",
      client: CLIENTS[CLIENTS.length - 1],
    },
    { key: "transitions", name: "QA transiciones de estado", status: "en_ejecucion", client: "Café Ñandú" },
    { key: "checklistEmpty", name: "QA checklist vacío", status: "en_ejecucion", client: "Café Ñandú" },
    { key: "checklistOne", name: "QA checklist uno", status: "en_ejecucion", client: "Café Ñandú" },
    { key: "checklistBig", name: "QA checklist grande", status: "en_ejecucion", client: "Café Ñandú" },
    { key: "notes", name: "QA notas", status: "en_ejecucion", client: "Café Ñandú" },
    { key: "invoiceOnly", name: "QA factura anulada", status: "finalizado", client: "Pingüino Frío S.A.", closed_at: "2025-03-10T15:00:00Z" },
    // Year boundary in Santiago: 2025-12-31 23:30 local = 2026-01-01 02:30 UTC.
    { key: "yearEdge", name: "QA cierre fin de año", status: "cerrado", client: "Inversiones Ébano", closed_at: "2026-01-01T02:30:00Z" },
  ];

  const rows = special.map((s) => ({
    company_id: company.id,
    client_id: clientByName.get(s.client),
    business_area_id: pick(areas).id,
    name: s.name,
    status: s.status,
    hold_reason: s.hold_reason ?? null,
    closed_at: s.closed_at ?? null,
    quoted_amount: 1000000,
  }));
  for (let i = rows.length; i < 300; i += 1) {
    const status = STATUSES[i % STATUSES.length];
    const closed = ["finalizado", "cerrado", "cancelado"].includes(status);
    const year = rnd() < 0.5 ? 2025 : 2026;
    const month = year === 2026 ? 1 + Math.floor(rnd() * 9) : 1 + Math.floor(rnd() * 12);
    const day = 1 + Math.floor(rnd() * 27);
    const clientName = pick(CLIENTS);
    rows.push({
      company_id: company.id,
      client_id: clientByName.get(clientName),
      business_area_id: pick(areas).id,
      name: `${pick(WORDS)} ${clientName.split(" ")[0]} #${String(i).padStart(3, "0")}`,
      status,
      hold_reason: status === "en_espera" ? "Motivo QA" : null,
      closed_at: closed ? new Date(Date.UTC(year, month - 1, day, 15)).toISOString() : null,
      quoted_amount: Math.round(rnd() * 5000000),
      start_date: `${year}-${String(month).padStart(2, "0")}-01`,
    });
  }
  const projects = await ok(db.from("projects").insert(rows).select("id, name, status, client_id"), "projects");
  special.forEach((s) => {
    state.projects[s.key] = projects.find((p) => p.name === s.name).id;
  });
  save();

  // Quotes: two thirds of the projects, some with two numbers.
  const quotes = [];
  projects.forEach((p, i) => {
    if (i % 3 === 2) return;
    quotes.push({ company_id: company.id, project_id: p.id, quote_number: `${tag}-Q${1000 + i}` });
    if (i % 10 === 0) quotes.push({ company_id: company.id, project_id: p.id, quote_number: `${tag}-Q${5000 + i}` });
  });
  quotes.push({ company_id: company.id, project_id: state.projects.percent, quote_number: `${tag}-50%OFF` });
  await ok(db.from("project_quotes").insert(quotes), "quotes");

  // Sales documents: invoices (some voided), receipts, credit notes, manual.
  const docs = [];
  projects.forEach((p, i) => {
    if (i % 4 !== 0) return;
    const type = ["invoice", "invoice", "receipt", "credit_note", "manual"][i % 5];
    docs.push({
      company_id: company.id,
      client_id: p.client_id,
      project_id: p.id,
      document_type: type,
      document_number: `${tag}-${type === "invoice" ? "F" : type === "receipt" ? "B" : type === "credit_note" ? "NC" : "M"}${2000 + i}`,
      document_date: i % 8 === 0 ? "2025-06-15" : "2026-02-10",
      currency: "CLP",
      net_amount: 100000,
      tax_amount: 19000,
      total_amount: 119000,
      voided: i % 12 === 0,
    });
  });
  docs.push({
    company_id: company.id,
    client_id: projects.find((p) => p.id === state.projects.invoiceOnly).client_id,
    project_id: state.projects.invoiceOnly,
    document_type: "invoice",
    document_number: `${tag}-FANULADA`,
    document_date: "2025-03-01",
    currency: "CLP",
    net_amount: 1,
    tax_amount: 0,
    total_amount: 1,
    voided: true,
  });
  await ok(db.from("sales_documents").insert(docs), "sales documents");
  // An invoice annulled by a credit note (not searchable, nor the note).
  const annulledJob = projects.find((p) => p.id === state.projects.invoiceOnly);
  const [annulledInvoice] = await ok(
    db
      .from("sales_documents")
      .insert({
        company_id: company.id,
        client_id: annulledJob.client_id,
        project_id: annulledJob.id,
        document_type: "invoice",
        document_number: `${tag}-FNCANU`,
        document_date: "2025-03-05",
        currency: "CLP",
        net_amount: 50000,
        tax_amount: 9500,
        total_amount: 59500,
        voided: false,
      })
      .select("id"),
    "annulled invoice",
  );
  const [creditNote] = await ok(
    db
      .from("sales_documents")
      .insert({
        company_id: company.id,
        client_id: annulledJob.client_id,
        project_id: annulledJob.id,
        document_type: "credit_note",
        document_number: `${tag}-NCANU`,
        document_date: "2025-03-06",
        currency: "CLP",
        net_amount: 50000,
        tax_amount: 9500,
        total_amount: 59500,
        voided: false,
        annuls_document_id: annulledInvoice.id,
      })
      .select("id"),
    "credit note",
  );
  await ok(
    db.from("sales_documents").update({ annulled_by_document_id: creditNote.id }).eq("id", annulledInvoice.id),
    "annul invoice",
  );
  state.counts = { projects: projects.length, quotes: quotes.length, docs: docs.length + 2 };

  // Checklists: 0, 1 and 35 items, plus a few small ones across the list.
  const items = [
    { project_id: state.projects.checklistOne, text: "Único ítem", position: 0, is_done: false },
    ...Array.from({ length: 35 }, (_, i) => ({
      project_id: state.projects.checklistBig,
      text: i === 7 ? `Ítem muy largo ${"con mucho texto que no tiene espacios-".repeat(6)}${"x".repeat(120)}` : `Tarea ${i + 1} — revisar ñandú 🚀`,
      position: i,
      is_done: i % 3 === 0,
    })),
  ];
  projects.slice(20, 60).forEach((p, i) => {
    for (let k = 0; k <= i % 5; k += 1) items.push({ project_id: p.id, text: `Paso ${k + 1}`, position: k, is_done: k % 2 === 0 });
  });
  await ok(
    db.from("project_checklist_items").insert(items.map((it) => ({ company_id: company.id, created_by: owner.id, ...it }))),
    "checklist",
  );

  const longNote = [
    "Visita técnica 🛠️ al cliente Ñuñoa.",
    "",
    "Pendientes:",
    "- Comprar 3 cámaras 📷",
    "- Ver plano en https://example.com/planos/peñalolén?v=1&x=2 (versión final).",
    "- Revisar www.inma.cl/soporte.",
    "",
    "Texto largo: " + "lorem ipsum dolor sit amet ".repeat(40),
  ].join("\n");
  await ok(
    db.from("project_notes").insert([
      { company_id: company.id, project_id: state.projects.notes, kind: "note", body: longNote, author_id: owner.id },
      { company_id: company.id, project_id: state.projects.notes, kind: "note", body: "Nota corta 😀", author_id: owner.id },
    ]),
    "notes",
  );

  save();
  console.log(JSON.stringify({ tag, companyId: company.id, counts: state.counts }));
}

// Finds everything by the zz-qa- prefix (not only the state file), so a
// half-finished seed is cleaned too.
async function cleanup() {
  const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};
  const found = await ok(db.from("companies").select("id").like("name", "zz-qa-%"), "find companies");
  const companies = [...new Set([...(state.companies ?? []), ...found.map((c) => c.id)])];
  const users = [];
  for (let page = 1; ; page += 1) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    users.push(...data.users.filter((u) => u.email?.startsWith("zz-qa-")).map((u) => ({ id: u.id, email: u.email })));
    if (data.users.length < 200) break;
  }
  state.users = users;
  state.tag = `${companies.length} companies, ${users.length} users`;
  if (companies.length) {
    // Every public table with a company_id, retried until FKs allow it.
    // Every public table with a company_id column (dev, 2026-10-07).
    const order = [
      "project_notes",
      "project_checklist_items",
      "mcp_pending_drafts",
      "technician_payment_applications",
      "technician_payments",
      "technician_charges",
      "sales_documents",
      "project_quotes",
      "cost_documents",
      "cost_import_batches",
      "import_batches",
      "recurring_service_cost_pools",
      "recurring_services",
      "projects",
      "client_aliases",
      "clients",
      "suppliers",
      "personnel",
      "business_areas",
      "company_memberships",
    ];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      for (const table of order) {
        const { error } = await db.from(table).delete().in("company_id", companies);
        if (error && !/does not exist|column .* does not exist|schema cache/i.test(error.message)) {
          console.log(`retry ${table}: ${error.message}`);
        }
      }
    }
    const { error } = await db.from("companies").delete().in("id", companies);
    if (error) throw new Error(`companies: ${error.message}`);
  }
  for (const user of state.users ?? []) {
    await db.from("company_memberships").delete().eq("user_id", user.id);
    const { error } = await db.auth.admin.deleteUser(user.id);
    if (error) console.log(`user ${user.email}: ${error.message}`);
  }
  rmSync(STATE, { force: true });
  console.log("cleaned", state.tag);
}

const command = process.argv[2];
if (command === "seed") await seedAll();
else if (command === "cleanup") await cleanup();
else throw new Error("seed | cleanup");
