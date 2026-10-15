import "server-only";

import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseEnv } from "@/lib/supabase/env";
import { createServiceRoleClient } from "@/lib/supabase/service";

/**
 * A Supabase client signed in AS the owner of an MCP token, so MCP tool
 * calls run the app's own code (lib/ai/tools.ts, lib/dal, lib/reporting)
 * under RLS and with auth.uid() set -- the RPCs that create documents
 * and jobs (create_cost_document, create_sales_document,
 * create_project_with_quote) refuse to run without it, which is why
 * confirming a draft from MCP used to fail under the service-role client.
 *
 * How: the service role only mints a one-time sign-in link for that user
 * (auth.admin.generateLink -- nothing is emailed) and the link's token is
 * exchanged right away for a normal session (verifyOtp). The service role
 * itself never touches company data any more.
 *
 * The session is reused per user while its access token has more than
 * two minutes left, so a chat of many tool calls signs in once instead of
 * on every call (Supabase rate-limits token verifications per IP).
 */

type CachedSession = { accessToken: string; refreshToken: string; expiresAt: number };

const sessionCache = new Map<string, CachedSession>();
const REUSE_MARGIN_MS = 2 * 60 * 1000;

function newAnonClient(): SupabaseClient {
  const { url, anonKey } = getSupabaseEnv();
  // persistSession: false keeps the session in this client's memory only.
  return createSupabaseClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

export class McpSessionError extends Error {}

async function signInFresh(userId: string): Promise<{ client: SupabaseClient; session: CachedSession }> {
  const admin = createServiceRoleClient();

  const { data: userData, error: userError } = await admin.auth.admin.getUserById(userId);
  const email = userData?.user?.email;
  if (userError || !email) {
    console.error(userError);
    throw new McpSessionError("No se encontró el usuario dueño del token.");
  }

  const { data: link, error: linkError } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  const tokenHash = link?.properties?.hashed_token;
  if (linkError || !tokenHash) {
    console.error(linkError);
    throw new McpSessionError("No se pudo iniciar la sesión del usuario para el MCP.");
  }

  const client = newAnonClient();
  let { data, error } = await client.auth.verifyOtp({ token_hash: tokenHash, type: "email" });
  if (error || !data.session) {
    // Older Auth servers only accept the magic-link type for this token.
    ({ data, error } = await client.auth.verifyOtp({ token_hash: tokenHash, type: "magiclink" }));
  }
  if (error || !data.session || data.session.user.id !== userId) {
    console.error(error);
    throw new McpSessionError("No se pudo iniciar la sesión del usuario para el MCP.");
  }

  const session: CachedSession = {
    accessToken: data.session.access_token,
    refreshToken: data.session.refresh_token,
    expiresAt: (data.session.expires_at ?? 0) * 1000,
  };
  return { client, session };
}

export async function getMcpUserClient(userId: string): Promise<SupabaseClient> {
  const cached = sessionCache.get(userId);
  if (cached && cached.expiresAt - Date.now() > REUSE_MARGIN_MS) {
    const client = newAnonClient();
    const { data, error } = await client.auth.setSession({
      access_token: cached.accessToken,
      refresh_token: cached.refreshToken,
    });
    if (!error && data.session?.user.id === userId) {
      return client;
    }
    sessionCache.delete(userId);
  }

  const { client, session } = await signInFresh(userId);
  sessionCache.set(userId, session);
  return client;
}

/** Test hook. */
export function clearMcpSessionCache() {
  sessionCache.clear();
}
