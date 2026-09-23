"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { todayForCountry } from "@/lib/recurringServicePending";

export type MarkOccurrenceResult = { error: string | null };

type Transition = {
  from: string[];
  to: "invoiced" | "collected" | "void";
  // Which date column the transition stamps with today's date, if any.
  stamp: "invoiced_at" | "collected_at" | null;
};

// The plan's state machine, simplified as agreed: "invoiced" already
// means "pending collection" (pending_collection stays unused), and void
// is final -- the occurrence keeps its (service, period) slot, so the
// monthly job never regenerates it.
const TRANSITIONS = {
  invoice: { from: ["pending_invoice"], to: "invoiced", stamp: "invoiced_at" },
  collect: { from: ["invoiced"], to: "collected", stamp: "collected_at" },
  void: { from: ["pending_invoice", "invoiced"], to: "void", stamp: null },
} satisfies Record<string, Transition>;

const GENERIC_ERROR = "Algo salió mal. Probá de nuevo.";

/**
 * Moves one occurrence along TRANSITIONS after confirming it belongs to
 * companyId and is still in an allowed status -- defense-in-depth
 * alongside the RLS UPDATE policy (recurring_service_occurrences has no
 * company_id of its own, see 20260922010000; RLS only checks "some
 * company the caller is a member of", not this specific companyId).
 * The UPDATE repeats the status filter, so two people tapping at once
 * can't both apply it.
 */
async function transition(
  companyId: string,
  occurrenceId: string,
  { from, to, stamp }: Transition,
): Promise<MarkOccurrenceResult> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("recurring_service_occurrences")
    .select("status, recurring_services!inner(company_id, companies(country))")
    .eq("id", occurrenceId)
    .maybeSingle();

  if (error) {
    console.error(error);
    return { error: GENERIC_ERROR };
  }

  type Embedded = { company_id: string; companies: { country: string | null } | { country: string | null }[] | null };
  const service = data
    ? ((Array.isArray(data.recurring_services)
        ? data.recurring_services[0]
        : data.recurring_services) as Embedded | undefined)
    : undefined;

  if (!data || service?.company_id !== companyId) {
    return { error: "No se encontró este pendiente." };
  }

  if (!from.includes(data.status)) {
    return {
      error: "Este pendiente ya cambió de estado (quizás alguien lo marcó recién). Actualizá la página.",
    };
  }

  const company = Array.isArray(service.companies) ? service.companies[0] : service.companies;
  const changes: Record<string, string> = { status: to };
  if (stamp) changes[stamp] = todayForCountry(company?.country ?? null);

  const { data: updated, error: updateError } = await supabase
    .from("recurring_service_occurrences")
    .update(changes)
    .eq("id", occurrenceId)
    .in("status", from)
    .select("id");

  if (updateError) {
    console.error(updateError);
    return { error: GENERIC_ERROR };
  }

  if (!updated || updated.length === 0) {
    return {
      error: "Este pendiente ya cambió de estado (quizás alguien lo marcó recién). Actualizá la página.",
    };
  }

  revalidatePath(`/companies/${companyId}/recurring-services/pending`);
  revalidatePath(`/companies/${companyId}/recurring-services`);
  return { error: null };
}

export async function markOccurrenceInvoiced(companyId: string, occurrenceId: string) {
  return transition(companyId, occurrenceId, TRANSITIONS.invoice);
}

export async function markOccurrenceCollected(companyId: string, occurrenceId: string) {
  return transition(companyId, occurrenceId, TRANSITIONS.collect);
}

export async function voidOccurrence(companyId: string, occurrenceId: string) {
  return transition(companyId, occurrenceId, TRANSITIONS.void);
}
