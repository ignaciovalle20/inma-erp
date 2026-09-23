/**
 * Shared plumbing for the *.integration.test.ts suite, which runs against
 * the real inma-erp-dev Supabase project (never prod). Two channels:
 * - supabase-js with the keys in web/.env.local (loaded by
 *   vitest.integration.config.ts), for anything reachable over the API.
 * - `supabase db query --linked` (the CLI, authenticated with the
 *   developer's own `supabase login`), for SQL the API can't run --
 *   e.g. a transaction that is rolled back at the end.
 *
 * assertDevProject() refuses to continue unless *both* point at dev.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

export const DEV_PROJECT_REF = "sczgankronafrxybpvnh";

const WEB_DIR = path.resolve(__dirname, "../../../..");
const REPO_DIR = path.resolve(WEB_DIR, "..");

export function assertDevProject() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  if (new URL(url).host !== `${DEV_PROJECT_REF}.supabase.co`) {
    throw new Error(
      `Integration tests only run against inma-erp-dev (${DEV_PROJECT_REF}); NEXT_PUBLIC_SUPABASE_URL points elsewhere.`,
    );
  }

  const linkedRef = readFileSync(
    path.join(REPO_DIR, "supabase/.temp/project-ref"),
    "utf8",
  ).trim();
  if (linkedRef !== DEV_PROJECT_REF) {
    throw new Error(
      `Integration tests only run against inma-erp-dev; the Supabase CLI is linked to ${linkedRef}.`,
    );
  }

  for (const name of [
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "CRON_SECRET",
  ]) {
    if (!process.env[name]) throw new Error(`Missing ${name} in web/.env.local`);
  }
}

const noSession = { auth: { autoRefreshToken: false, persistSession: false } };

export function serviceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    noSession,
  );
}

export function anonClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    noSession,
  );
}

/**
 * Runs `sql` (may be several statements) on the linked dev project and
 * returns the rows of the last statement that returned any. Throws with
 * the database's own error message on failure.
 */
export function runLinkedSql<T = Record<string, unknown>>(sql: string): T[] {
  const env = { ...process.env };
  // A stale, differently-scoped token in the environment overrides the
  // developer's `supabase login` and can't see the dev project.
  delete env.SUPABASE_ACCESS_TOKEN;

  const result = spawnSync(
    process.execPath,
    [
      path.join(WEB_DIR, "node_modules/supabase/dist/supabase.js"),
      "db",
      "query",
      "--linked",
      sql,
    ],
    { cwd: REPO_DIR, env, encoding: "utf8" },
  );

  // The CLI reports SQL errors as a JSON object (sometimes with exit
  // code 0), on stdout or stderr depending on the version.
  const output = [result.stdout, result.stderr].find((s) => s?.includes("{")) ?? "";
  let json: { rows?: unknown[]; error?: { message?: string }; _tag?: string };
  try {
    json = JSON.parse(output.slice(output.indexOf("{")));
  } catch {
    throw new Error(`supabase db query failed: ${result.stderr || result.stdout}`);
  }
  if (json._tag === "Error" || json.error || result.status !== 0) {
    throw new Error(json.error?.message ?? `supabase db query exited ${result.status}`);
  }
  return (json.rows ?? []) as T[];
}

// Plain calendar-date helpers (YYYY-MM-DD strings, UTC -- the dev
// database's TimeZone is UTC, so its current_date matches these).
export function ymd(year: number, month: number, day: number) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function lastDayOfMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function todayUtc() {
  const now = new Date();
  return {
    year: now.getUTCFullYear(),
    month: now.getUTCMonth() + 1,
    day: now.getUTCDate(),
  };
}

export function addMonths(year: number, month: number, delta: number) {
  const zeroBased = year * 12 + (month - 1) + delta;
  return { year: Math.floor(zeroBased / 12), month: (zeroBased % 12) + 1 };
}
