import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { suggestCostAllocations } from "@/lib/costAllocationSuggestionsLoader";

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

  // Constant-time comparison: `===` leaks how many leading characters match.
  const header = Buffer.from(request.headers.get("authorization") ?? "");
  const wanted = Buffer.from(`Bearer ${expected}`);
  return header.length === wanted.length && timingSafeEqual(header, wanted);
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

  // The same run makes the month's cost periods: offer them the purchase
  // invoices already imported (best effort -- never fails the cron).
  await suggestCostsForNewPeriods(supabase);

  return NextResponse.json({
    generated: data?.length ?? 0,
    occurrences: data ?? [],
  });
}

async function suggestCostsForNewPeriods(supabase: ReturnType<typeof createServiceRoleClient>) {
  try {
    const { data: services, error } = await supabase
      .from("recurring_services")
      .select("company_id")
      .eq("status", "active")
      .eq("uses_cost_pool", false)
      .not("supplier_id", "is", null);
    if (error) throw error;
    const month = new Date().toISOString().slice(0, 7);
    const companies = [...new Set((services ?? []).map((row) => row.company_id as string))];
    for (const companyId of companies) {
      const result = await suggestCostAllocations(
        supabase as unknown as Parameters<typeof suggestCostAllocations>[0],
        companyId,
        { month },
      );
      if (result.error) console.error(result.error);
    }
  } catch (error) {
    console.error(error);
  }
}

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return runGeneration();
}
