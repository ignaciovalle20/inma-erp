import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/service";

// Vercel Cron target (see vercel.json's "crons" entry): runs monthly
// and materializes this period's recurring_service_occurrences rows
// for every active recurring_services template, across every company.
// plan-servicios-recurrentes.md Phase 4 -- confirmed with the user:
// Vercel Cron, not pg_cron.
//
// Vercel signs cron requests with `Authorization: Bearer $CRON_SECRET`
// (https://vercel.com/docs/cron-jobs/manage-cron-jobs#securing-cron-jobs).
// This route re-checks that header itself rather than trusting network
// position -- the same "never assume, always re-verify" discipline the
// MCP route applies to its own bearer token (lib/mcp/auth.ts), since
// this route also reaches for the service-role client afterward.
export const runtime = "nodejs";

function isAuthorized(request: Request): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;

  const header = request.headers.get("authorization");
  return header === `Bearer ${expected}`;
}

async function runGeneration() {
  const supabase = createServiceRoleClient();

  // security definer RPC (see migration 20260922030000) -- the only
  // supported way to call this: never grant it to `authenticated`,
  // since an ordinary user must not be able to trigger cross-company
  // generation on demand.
  const { data, error } = await supabase.rpc(
    "generate_due_recurring_service_occurrences",
  );

  if (error) {
    console.error(error);
    return NextResponse.json(
      { error: "Generation failed. See server logs." },
      { status: 500 },
    );
  }

  return NextResponse.json({
    generated: data?.length ?? 0,
    occurrences: data ?? [],
  });
}

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return runGeneration();
}
