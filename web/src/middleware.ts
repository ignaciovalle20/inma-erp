import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { getSupabaseEnv } from "@/lib/supabase/env";

// Routes reachable without a session.
const PUBLIC_ROUTES = ["/login"];

/**
 * Runs on every app request. Refreshes the Supabase session cookie via
 * getClaims(), and redirects unauthenticated requests for app routes to
 * /login. Uses the anon key only — never service_role.
 *
 * Named/filed as `middleware.ts` (the pre-Next-16 convention), not the
 * newer `proxy.ts` rename — Vercel's routing-manifest generation has an
 * active bug with `proxy.ts` on Next.js 16 (sitewide 404 despite a
 * successful build; see vercel/next.js community reports). `middleware.ts`
 * still works and is the deployed workaround until that's fixed upstream.
 */
export async function middleware(request: NextRequest) {
  let response = NextResponse.next({
    request,
  });

  const { url, anonKey } = getSupabaseEnv();

  const supabase = createServerClient(
    url,
    anonKey,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          response = NextResponse.next({
            request,
          });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // IMPORTANT: do not run any logic between createServerClient and
  // getClaims() — it refreshes the auth token and must run on every
  // request to keep the session cookie valid.
  //
  // getClaims() verifies the JWT locally (via WebCrypto, cached JWKS)
  // instead of always calling the Auth server like getUser() does --
  // but only once the project's JWT signing keys are asymmetric
  // (Supabase dashboard: Authentication > Sign In / Providers > JWT
  // Keys). Until that's enabled it transparently falls back to a
  // getUser()-equivalent server round trip, so this is a strict
  // improvement with no behavior change either way.
  let authenticated = false;
  try {
    const { data, error } = await supabase.auth.getClaims();
    authenticated = !error && data !== null;
  } catch {
    const loginUrl = new URL("/login", request.url);
    return NextResponse.redirect(loginUrl);
  }

  const pathname = request.nextUrl.pathname;
  const isPublicRoute = PUBLIC_ROUTES.some((route) => route === pathname);

  if (!authenticated && !isPublicRoute) {
    const loginUrl = new URL("/login", request.url);
    return NextResponse.redirect(loginUrl);
  }

  if (authenticated && pathname === "/login") {
    const homeUrl = new URL("/", request.url);
    return NextResponse.redirect(homeUrl);
  }

  return response;
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico, and common static asset extensions
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
