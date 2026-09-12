import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { getSupabaseEnv } from "@/lib/supabase/env";

/**
 * Creates a Supabase client for use in Server Components, Server
 * Actions, and Route Handlers. Uses the anon key only — never the
 * service_role key. RLS enforces company scoping, not this client.
 */
export async function createClient() {
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
