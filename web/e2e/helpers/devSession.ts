/**
 * Shared setup for the e2e specs, the pattern of
 * e2e/recurring-services-location.spec.ts: only against inma-erp-dev,
 * throwaway companies and users created through the admin API, the user
 * signed in server-side (the session cookies are handed to the browser --
 * no credentials are ever typed into a page), and everything deleted in
 * afterAll. Every name starts with "zz-test-e2e-".
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { BrowserContext, Page } from "@playwright/test";
import { loadEnvConfig } from "@next/env";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

loadEnvConfig(path.resolve(__dirname, "../.."));

export const DEV_PROJECT_REF = "sczgankronafrxybpvnh";
export const PREFIX = "zz-test-e2e-";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

export function newTag(): string {
  return `${PREFIX}${randomUUID().slice(0, 8)}`;
}

/** Refuses to go on unless web/.env.local points at inma-erp-dev. */
export function assertDev() {
  if (new URL(url).host !== `${DEV_PROJECT_REF}.supabase.co`) {
    throw new Error(`E2E only runs against inma-erp-dev (${DEV_PROJECT_REF}).`);
  }
  if (!serviceKey || !anonKey) throw new Error("Missing Supabase keys in web/.env.local");
}

const noSession = { auth: { autoRefreshToken: false, persistSession: false } };

export function admin(): SupabaseClient {
  return createClient(url, serviceKey, noSession);
}

/** `{ data }` of a Supabase call, or a thrown error that says what failed. */
export async function ok<T>(p: PromiseLike<{ data: unknown; error: unknown }>, what: string): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(`${what}: ${JSON.stringify(error)}`);
  return data as T;
}

export async function createCompany(name: string, country: string, currency: string): Promise<string> {
  const row = await ok<{ id: string }>(
    admin().from("companies").insert({ name, country, currency }).select("id").single(),
    `company ${name}`,
  );
  return row.id;
}

export type Member = {
  userId: string;
  /** Session cookies, as the app's server client sets them. */
  cookies: { name: string; value: string }[];
  /** The same user through supabase-js (RLS applies), for RPCs the seed needs. */
  client: SupabaseClient;
};

/** A throwaway admin member of `companyIds`, signed in server-side. */
export async function createMember(tag: string, companyIds: string[]): Promise<Member> {
  const db = admin();
  const email = `${tag}@example.test`;
  const password = randomBytes(24).toString("base64url");
  const { data, error } = await db.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  const userId = data.user.id;

  await ok(
    db
      .from("company_memberships")
      .insert(companyIds.map((companyId) => ({ user_id: userId, company_id: companyId, role: "admin" })))
      .select("id"),
    "memberships",
  );

  const jar = new Map<string, string>();
  const ssr = createServerClient(url, anonKey, {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (toSet) => toSet.forEach(({ name, value }) => jar.set(name, value)),
    },
  });
  const { error: signInError } = await ssr.auth.signInWithPassword({ email, password });
  if (signInError) throw signInError;

  const client = createClient(url, anonKey, noSession);
  const { error: clientError } = await client.auth.signInWithPassword({ email, password });
  if (clientError) throw clientError;

  return { userId, cookies: [...jar].map(([name, value]) => ({ name, value })), client };
}

export async function signIn(context: BrowserContext, member: Member) {
  await context.addCookies(
    member.cookies.map((c) => ({ ...c, domain: "localhost", path: "/", sameSite: "Lax" as const })),
  );
}

/** Deletes the companies and every row that hangs from them. Returns what failed. */
export async function deleteCompanies(companyIds: string[]): Promise<string[]> {
  const failures: string[] = [];
  if (companyIds.length === 0) return failures;
  const db = admin();
  const none = ["00000000-0000-0000-0000-000000000000"];
  const list = (values: string[]) => (values.length > 0 ? values : none);
  const ids = async (table: string, column = "company_id") =>
    ((await db.from(table).select("id").in(column, companyIds)).data ?? []).map((row: { id: string }) => row.id);
  const step = async (label: string, p: PromiseLike<{ error: unknown }>) => {
    const { error } = await p;
    if (error) failures.push(`${label}: ${JSON.stringify(error)}`);
  };

  const services = await ids("recurring_services");
  const pools = await ids("recurring_service_cost_pools");
  const costDocs = await ids("cost_documents");
  const projects = await ids("projects");
  const costBatches = await ids("cost_import_batches");

  // Technicians (charges point at cost documents). Linked documents must be
  // unlinked by a member first (unlink_technician_document): a bare delete
  // of a link is refused even to the service role.
  await step("technician suggestions", db.from("technician_document_suggestions").delete().in("company_id", companyIds));
  await step("technician payments", db.from("technician_payments").delete().in("company_id", companyIds));
  await step("technician charges", db.from("technician_charges").delete().in("company_id", companyIds));
  await step("technician suppliers", db.from("technician_suppliers").delete().in("company_id", companyIds));
  await step("personnel", db.from("personnel").delete().in("company_id", companyIds));
  await step("rs allocations", db.from("recurring_service_cost_allocations").delete().in("cost_pool_id", list(pools)));
  await step("pools", db.from("recurring_service_cost_pools").delete().in("company_id", companyIds));
  await step("occurrences", db.from("recurring_service_occurrences").delete().in("recurring_service_id", list(services)));
  await step("services", db.from("recurring_services").delete().in("company_id", companyIds));
  await step("cost allocations", db.from("cost_allocations").delete().in("cost_document_id", list(costDocs)));
  await step("cost attachments", db.from("cost_document_attachments").delete().in("cost_document_id", list(costDocs)));
  await step("cost lines", db.from("cost_lines").delete().in("cost_document_id", list(costDocs)));
  await step("cost confirmations", db.from("project_cost_confirmations").delete().in("project_id", list(projects)));
  await step("unlink cost import rows", db.from("cost_documents").update({ import_row_id: null }).in("company_id", companyIds));
  await step("cost import rows", db.from("cost_import_rows").delete().in("import_batch_id", list(costBatches)));
  await step("cost docs", db.from("cost_documents").delete().in("company_id", companyIds));
  await step("cost import batches", db.from("cost_import_batches").delete().in("company_id", companyIds));
  await step(
    "unpair",
    db.from("sales_documents").update({ annulled_by_document_id: null, annuls_document_id: null }).in("company_id", companyIds),
  );
  const sales = await ids("sales_documents");
  const batches = await ids("import_batches");
  await step("unlink import rows", db.from("sales_documents").update({ import_row_id: null }).in("company_id", companyIds));
  await step("import rows", db.from("import_rows").delete().in("import_batch_id", list(batches)));
  await step("sales lines", db.from("sales_lines").delete().in("sales_document_id", list(sales)));
  await step("sales", db.from("sales_documents").delete().in("company_id", companyIds));
  await step("import batches", db.from("import_batches").delete().in("company_id", companyIds));
  await step("quotes", db.from("project_quotes").delete().in("company_id", companyIds));
  await step("projects", db.from("projects").delete().in("company_id", companyIds));
  await step("suppliers", db.from("suppliers").delete().in("company_id", companyIds));
  await step("aliases", db.from("client_aliases").delete().in("company_id", companyIds));
  await step("clients", db.from("clients").delete().in("company_id", companyIds));
  await step("areas", db.from("business_areas").delete().in("company_id", companyIds));
  await step("memberships", db.from("company_memberships").delete().in("company_id", companyIds));
  await step("companies", db.from("companies").delete().in("id", companyIds));
  return failures;
}

export async function deleteUser(userId: string | undefined): Promise<string[]> {
  if (!userId) return [];
  const { error } = await admin().auth.admin.deleteUser(userId);
  return error ? [`user: ${error.message}`] : [];
}

/** How many rows / users named with `prefix` are left (all should be 0 after a spec). */
export async function leftovers(prefix: string = PREFIX) {
  const db = admin();
  const count = async (table: string, column = "name") =>
    (await db.from(table).select("id", { count: "exact", head: true }).like(column, `${prefix}%`)).count ?? 0;
  const { data } = await db.auth.admin.listUsers({ perPage: 1000 });
  return {
    companies: await count("companies"),
    clients: await count("clients"),
    users: (data?.users ?? []).filter((user) => (user.email ?? "").startsWith(prefix)).length,
  };
}

const SCREENSHOT_DIR = path.resolve(__dirname, "../screenshots/2026-10-14");

export async function snap(page: Page, name: string) {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${name}.png`), fullPage: true });
}

/** An amount as the app's <Money> writes it (de-DE, 0 decimals for CLP, 2 otherwise). */
export function formatAmount(value: number, currency: string): string {
  const decimals = currency === "CLP" ? 0 : 2;
  return value.toLocaleString("de-DE", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Regex source for an amount with its currency code ("1.500,00 USD", spaces optional). */
export function money(value: number, currency: string): string {
  return `${escape(formatAmount(value, currency))}\\s*${currency}`;
}

/** A regex made of parts joined by optional whitespace. */
export function seq(...parts: string[]): RegExp {
  return new RegExp(parts.join("\\s*"));
}

/** `text` escaped for a regex. */
export function lit(text: string): string {
  return escape(text);
}
