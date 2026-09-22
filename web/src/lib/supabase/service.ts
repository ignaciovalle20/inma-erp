import "server-only";

import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { getSupabaseEnv } from "@/lib/supabase/env";

/**
 * Service-role Supabase client -- bypasses RLS entirely. Used by
 * routes with no browser session cookie to authenticate a normal
 * RLS-scoped client with, each authenticating its caller a different
 * way instead:
 * - The MCP route (web/src/app/api/mcp/route.ts) -- a bearer token
 *   checked against mcp_access_tokens.
 * - The recurring-service-occurrences cron route
 *   (web/src/app/api/cron/recurring-service-occurrences/route.ts) --
 *   Vercel's own `Authorization: Bearer $CRON_SECRET`.
 *
 * Every caller of this client is responsible for re-checking its own
 * authorization from scratch before touching any row (for the cron
 * route, that's the CRON_SECRET check; for company-scoped writes it
 * would be a membership check, the same way
 * update_import_batch_counts does inside its own security-definer
 * function) -- there is no RLS safety net here.
 *
 * Never import this from anything reachable by a normal request (a
 * Server Component, a plain Server Action, another user-facing API
 * route) -- it must stay confined to routes that have their own
 * from-scratch authorization check, never one that just trusts RLS
 * would have applied.
 */
export function createServiceRoleClient() {
  const { url } = getSupabaseEnv();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!serviceRoleKey) {
    throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY env var");
  }

  return createSupabaseClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
