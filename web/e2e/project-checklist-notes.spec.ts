/**
 * Job detail page: checklist (add with Enter, tick, reorder, progress
 * x/y), notes timeline (Ctrl+Enter, links, author) and the status_change
 * event the database logs when the job's status changes; the projects
 * list shows the checklist progress. Then a member of another company
 * must not see any of it.
 *
 * Runs against inma-erp-dev only, with its own data (no seed: dev holds a
 * copy of prod): two throwaway companies "QA-…" (Chile and Uruguay), a job
 * in the Chilean one, and three throwaway users created through the admin
 * API (two members of Chile, so the notes show their author, and one of
 * Uruguay), signed in server-side (the session cookies are handed to the
 * browser -- no credentials are typed into the page). afterAll deletes the
 * job (its checklist and notes go with it, on delete cascade), the
 * companies, the memberships and the users.
 */
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { expect, test, type BrowserContext } from "@playwright/test";
import { loadEnvConfig } from "@next/env";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

loadEnvConfig(path.resolve(__dirname, ".."));

const DEV_PROJECT_REF = "sczgankronafrxybpvnh";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

const tag = `QA-${randomUUID().slice(0, 8)}`;
// Long on purpose: the list row must not squeeze its actions (see below).
const projectName = `${tag} trabajo con un nombre largo ${"para que la columna del proyecto ocupe casi todo el ancho ".repeat(3)}fin`;
// Auth keeps emails in lower case.
const memberEmail = `${tag.toLowerCase()}@example.test`;
const colleagueEmail = `${tag.toLowerCase()}-colega@example.test`;
const outsiderEmail = `${tag.toLowerCase()}-otra@example.test`;
// The throwaway companies and client, created in beforeAll.
const ids = { cl: "", uy: "", client: "" };
let basePath = "";
const userIds: string[] = [];
let projectId = "";
let memberCookies: { name: string; value: string }[] = [];
let outsiderCookies: { name: string; value: string }[] = [];
let outsiderClient: SupabaseClient;

test.describe.configure({ mode: "serial" });

function admin() {
  return createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
}

async function createMember(email: string, companyId: string): Promise<string> {
  const db = admin();
  const password = randomBytes(24).toString("base64url");
  const { data, error } = await db.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  userIds.push(data.user.id);

  const { error: membershipError } = await db
    .from("company_memberships")
    .insert({ user_id: data.user.id, company_id: companyId, role: "member" });
  if (membershipError) throw membershipError;

  return password;
}

async function sessionCookies(email: string, password: string) {
  const jar = new Map<string, string>();
  const ssr = createServerClient(url, anonKey, {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (toSet) => toSet.forEach(({ name, value }) => jar.set(name, value)),
    },
  });
  const { error } = await ssr.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return [...jar].map(([name, value]) => ({ name, value }));
}

test.beforeAll(async () => {
  if (new URL(url).host !== `${DEV_PROJECT_REF}.supabase.co`) {
    throw new Error(`E2E only runs against inma-erp-dev (${DEV_PROJECT_REF}).`);
  }
  const db = admin();

  const company = async (name: string, country: string, currency: string) => {
    const { data, error } = await db.from("companies").insert({ name, country, currency }).select("id").single();
    if (error) throw error;
    return data.id as string;
  };
  ids.cl = await company(`${tag} CL`, "CL", "CLP");
  ids.uy = await company(`${tag} UY`, "UY", "UYU");
  basePath = `/companies/${ids.cl}/projects`;
  const { data: client, error: clientError } = await db
    .from("clients")
    .insert({ company_id: ids.cl, name: `${tag} cliente` })
    .select("id")
    .single();
  if (clientError) throw clientError;
  ids.client = client.id;

  const memberPassword = await createMember(memberEmail, ids.cl);
  // A second member, so the notes show who wrote them.
  await createMember(colleagueEmail, ids.cl);
  const outsiderPassword = await createMember(outsiderEmail, ids.uy);
  memberCookies = await sessionCookies(memberEmail, memberPassword);
  outsiderCookies = await sessionCookies(outsiderEmail, outsiderPassword);

  outsiderClient = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { error: outsiderSignInError } = await outsiderClient.auth.signInWithPassword({
    email: outsiderEmail,
    password: outsiderPassword,
  });
  if (outsiderSignInError) throw outsiderSignInError;

  const { data: area, error: areaError } = await db
    .from("business_areas")
    .insert({ company_id: ids.cl, name: `${tag} Networking` })
    .select("id")
    .single();
  if (areaError) throw areaError;

  const { data: project, error: projectError } = await db
    .from("projects")
    .insert({
      company_id: ids.cl,
      client_id: ids.client,
      business_area_id: area.id,
      name: projectName,
      status: "en_ejecucion",
    })
    .select("id")
    .single();
  if (projectError) throw projectError;
  projectId = project.id;
});

test.afterAll(async () => {
  const db = admin();
  const failures: unknown[] = [];
  const step = async (p: PromiseLike<{ error: unknown }>) => {
    const { error } = await p;
    if (error) failures.push(error);
  };
  if (projectId) await step(db.from("projects").delete().eq("id", projectId));
  for (const userId of userIds) {
    await step(db.from("company_memberships").delete().eq("user_id", userId));
    const { error } = await db.auth.admin.deleteUser(userId);
    if (error) failures.push(error);
  }
  const companies = [ids.cl, ids.uy].filter(Boolean);
  if (companies.length > 0) {
    await step(db.from("clients").delete().in("company_id", companies));
    await step(db.from("business_areas").delete().in("company_id", companies));
    await step(db.from("company_memberships").delete().in("company_id", companies));
    await step(db.from("companies").delete().in("id", companies));
  }
  expect(failures).toEqual([]);
});

async function signIn(context: BrowserContext, cookies: { name: string; value: string }[]) {
  await context.addCookies(
    cookies.map((c) => ({ ...c, domain: "localhost", path: "/", sameSite: "Lax" as const })),
  );
}


test("checklist, notes and the status change event on the job detail page", async ({ page, context }) => {
  await signIn(context, memberCookies);
  await page.goto(`${basePath}/${projectId}`);

  // Checklist: Enter adds, the box keeps the focus for the next item.
  await expect(page.getByText("Todavía no hay ítems.")).toBeVisible();
  const newItem = page.getByLabel("Nuevo ítem del checklist");
  const progress = page.getByTestId("checklist-progress");
  for (const [index, text] of ["Comprar cable", "Instalar switch", "Probar enlace"].entries()) {
    await newItem.fill(text);
    await newItem.press("Enter");
    await expect(progress).toHaveText(`0/${index + 1}`);
    await expect(newItem).toHaveValue("");
  }

  await page.getByRole("checkbox", { name: /Comprar cable/ }).check();
  await expect(progress).toHaveText("1/3");
  await page.getByRole("checkbox", { name: /Instalar switch/ }).check();
  await expect(progress).toHaveText("2/3");
  await expect(page.getByRole("checkbox", { name: /Instalar switch/ })).toBeChecked();

  // Reorder: "Probar enlace" moves above "Instalar switch".
  await page.getByRole("button", { name: "Subir “Probar enlace”" }).click();
  await expect(page.getByRole("checkbox")).toHaveCount(3);
  await expect
    .poll(async () =>
      page.locator("li").filter({ has: page.getByRole("checkbox") }).allInnerTexts(),
    )
    .toEqual([
      expect.stringContaining("Comprar cable"),
      expect.stringContaining("Probar enlace"),
      expect.stringContaining("Instalar switch"),
    ]);

  // Notes: Ctrl+Enter saves; line breaks kept, links clickable, author
  // shown (the company has more than one member).
  const newNote = page.getByLabel("Nueva nota");
  await newNote.fill("Llamar al cliente\nPlano en https://example.com/plano.");
  await newNote.press("Control+Enter");
  await expect(newNote).toHaveValue("");
  const note = page.locator('li[data-kind="note"]').first();
  await expect(note).toContainText("Llamar al cliente");
  await expect(note.getByRole("link", { name: "https://example.com/plano" })).toHaveAttribute(
    "href",
    "https://example.com/plano",
  );
  await expect(note).toContainText(memberEmail);
  await expect(note.locator("time")).not.toHaveText("");
  await expect(note.getByRole("button", { name: "Editar" })).toBeVisible();

  // Change the status from the edit form; the timeline logs it.
  await page.goto(`${basePath}/${projectId}/edit`);
  await page.getByLabel("Estado").selectOption("finalizado");
  await page.getByRole("button", { name: "Guardar cambios" }).click();
  await expect(page).toHaveURL(new RegExp(`${basePath}$`));

  await page.goto(`${basePath}/${projectId}`);
  const event = page.locator('li[data-kind="status_change"]');
  await expect(event).toHaveCount(1);
  await expect(event).toContainText("Estado: En ejecución → Finalizado");
  await expect(event.getByRole("button")).toHaveCount(0);
  // Newest first: the event is above the note.
  await expect(page.locator("ol[aria-label='Notas del trabajo'] > li").first()).toHaveAttribute(
    "data-kind",
    "status_change",
  );

  // The projects list shows the checklist progress.
  await page.goto(`${basePath}?q=${encodeURIComponent(tag)}`);
  const row = page.locator("tbody tr").filter({ hasText: projectName });
  await expect(row).toHaveCount(1);
  await expect(row.getByTestId("checklist-progress")).toHaveText("☑ 2/3");
  // "+ Gasto" stays on one line next to a long name.
  const expenseLink = row.getByRole("link", { name: "+ Gasto" });
  const editLink = row.getByRole("link", { name: "Editar" });
  expect((await expenseLink.boundingBox())!.height).toBeLessThanOrEqual((await editLink.boundingBox())!.height + 1);
});

test("a member of another company sees neither the checklist nor the notes", async ({ page, context }) => {
  // The rows exist (so the empty reads below mean something).
  const db = admin();
  const { count: itemCount } = await db
    .from("project_checklist_items")
    .select("id", { count: "exact", head: true })
    .eq("project_id", projectId);
  const { count: noteCount } = await db
    .from("project_notes")
    .select("id", { count: "exact", head: true })
    .eq("project_id", projectId);
  expect(itemCount).toBe(3);
  expect(noteCount).toBe(2);

  const items = await outsiderClient.from("project_checklist_items").select("id").eq("project_id", projectId);
  expect(items.error).toBeNull();
  expect(items.data).toEqual([]);
  const notes = await outsiderClient.from("project_notes").select("id").eq("project_id", projectId);
  expect(notes.error).toBeNull();
  expect(notes.data).toEqual([]);

  const progress = await outsiderClient.rpc("project_checklist_progress", {
    p_company_id: ids.cl,
    p_project_ids: [projectId],
  });
  expect(progress.data ?? []).toEqual([]);
  const names = await outsiderClient.rpc("company_member_names", { p_company_id: ids.cl });
  expect(names.data ?? []).toEqual([]);

  // Nor write into them.
  const insertItem = await outsiderClient
    .from("project_checklist_items")
    .insert({ company_id: ids.cl, project_id: projectId, text: "intruso" });
  expect(insertItem.error).not.toBeNull();
  const insertNote = await outsiderClient
    .from("project_notes")
    .insert({ company_id: ids.cl, project_id: projectId, body: "intruso" });
  expect(insertNote.error).not.toBeNull();
  const tick = await outsiderClient
    .from("project_checklist_items")
    .update({ is_done: true })
    .eq("project_id", projectId)
    .select("id");
  expect(tick.data ?? []).toEqual([]);

  // The page itself sends them back to their companies.
  await signIn(context, outsiderCookies);
  await page.goto(`${basePath}/${projectId}`);
  await expect(page).not.toHaveURL(new RegExp(projectId));
  await expect(page.getByText("Comprar cable")).toHaveCount(0);
});
