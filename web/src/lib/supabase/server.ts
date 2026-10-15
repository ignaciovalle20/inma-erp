import { AsyncLocalStorage } from "node:async_hooks";
import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { getSupabaseEnv } from "@/lib/supabase/env";

/**
 * A request with no browser cookie that still acts as a signed-in user
 * (the MCP route, authenticated by a personal token -- see
 * lib/mcp/session.ts) runs its work inside runAsSessionClient with a
 * client already signed in as that user. Every createClient() call in
 * that scope (lib/dal, lib/reporting, ...) gets that client instead of
 * the cookie one, so the same code, RLS and auth.uid() apply.
 */
const sessionClientOverride = new AsyncLocalStorage<SupabaseClient>();

export function runAsSessionClient<T>(client: SupabaseClient, fn: () => Promise<T>): Promise<T> {
  return sessionClientOverride.run(client, fn);
}

/**
 * Creates a Supabase client for use in Server Components, Server
 * Actions, and Route Handlers. Uses the anon key only — never the
 * service_role key. RLS enforces company scoping, not this client.
 */
export async function createClient(): Promise<SupabaseClient> {
  const override = sessionClientOverride.getStore();
  if (override) {
    return override;
  }

  const cookieStore = await cookies();
  const { url, anonKey } = getSupabaseEnv();

  return createServerClient(
    url,
    anonKey,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) => {
              cookieStore.set(name, value, options);
            });
          } catch {
            // Called from a Server Component — the proxy already
            // refreshes the session cookie, so this can be ignored.
          }
        },
      },
    },
  );
}
