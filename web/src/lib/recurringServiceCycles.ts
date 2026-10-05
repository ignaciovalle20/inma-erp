import "server-only";

import type { createClient } from "@/lib/supabase/server";
import { todayForCountry } from "@/lib/recurringServicePending";

type Supabase = Awaited<ReturnType<typeof createClient>>;

export type SyncCyclesResult = {
  /** Cycles created from the service's start (floor January 2026) through this month. */
  created: number;
  /** Past cycles linked to an existing invoice (Chile / Nubox). */
  linked: number;
  /** Past cycles left flagged "revisar vínculo" (no invoice, or several candidates). */
  toReview: number;
  error: boolean;
};

/**
 * After a service is created or its start date changes: creates every
 * missing cycle from max(start, January 2026) through the current month
 * in the company's time zone (generate_recurring_service_occurrences_since_start,
 * idempotent, never touches existing cycles), then links those past
 * cycles to invoices already imported (match_recurring_service_occurrences_to_invoices)
 * so their income is never counted twice. Runs with the caller's session:
 * RLS keeps it to their own company.
 */
export async function syncRecurringServiceCycles(
  supabase: Supabase,
  companyId: string,
  serviceId: string,
  companyCountry: string | null,
): Promise<SyncCyclesResult> {
  const until = `${todayForCountry(companyCountry).slice(0, 7)}-01`;

  const { data: generated, error: generateError } = await supabase.rpc(
    "generate_recurring_service_occurrences_since_start",
    { p_service_id: serviceId, p_until: until },
  );
  if (generateError) {
    console.error(generateError);
    return { created: 0, linked: 0, toReview: 0, error: true };
  }

  const { data: matched, error: matchError } = await supabase.rpc(
    "match_recurring_service_occurrences_to_invoices",
    { p_company_id: companyId, p_service_id: serviceId, p_until: until },
  );
  if (matchError) {
    console.error(matchError);
    return { created: Array.isArray(generated) ? generated.length : 0, linked: 0, toReview: 0, error: true };
  }

  const results = (Array.isArray(matched) ? matched : []) as { result: string }[];
  return {
    created: Array.isArray(generated) ? generated.length : 0,
    linked: results.filter((r) => r.result.startsWith("linked_")).length,
    toReview: results.filter((r) => r.result.startsWith("review_")).length,
    error: false,
  };
}
