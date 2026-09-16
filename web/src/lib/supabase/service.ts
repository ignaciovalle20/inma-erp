import "server-only";

import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { getSupabaseEnv } from "@/lib/supabase/env";

/**
 * Service-role Supabase client -- bypasses RLS entirely. Used only by
 * the MCP route (web/src/app/api/mcp/route.ts), which has no browser
 * session cookie to authenticate a normal RLS-scoped client with (its
 * caller identifies itself via a bearer token instead -- see
 * mcp_access_tokens). Every caller of this client is responsible for
 * re-checking company membership itself before touching any row, the
 * same way update_import_batch_counts does inside its own
 * security-definer function -- there is no RLS safety net here.
 *
 * Never import this from anything reachable by a normal request (a
 * Server Component, a plain Server Action, another API route) --
 * it must stay confined to the one place that has its own
 * from-scratch authorization check.
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
