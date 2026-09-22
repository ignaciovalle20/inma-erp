"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import type { SupabaseClient } from "@supabase/supabase-js";

export type MarkOccurrenceResult = { error: string | null };

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Confirms an occurrence belongs to companyId and is in expectedStatus
 * before any write -- defense-in-depth alongside the RLS UPDATE policy
 * (recurring_service_occurrences has no company_id column of its own,
 * see 20260922010000; RLS only checks "some company the caller is a
 * member of", not this specific companyId). Same reasoning as every
 * other cross-company check in this codebase, just via a SELECT first
 * instead of a DB trigger, since these two actions are simple single-
 * row status transitions with no other write to wrap atomically.
 */
async function assertOccurrenceInCompany(
  supabase: SupabaseClient,
  companyId: string,
  occurrenceId: string,
  expectedStatus: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from("recurring_service_occurrences")
    .select("status, recurring_services!inner(company_id)")
    .eq("id", occurrenceId)
    .maybeSingle();

  if (error) {
    console.error(error);
    return "Something went wrong. Please try again.";
  }

  const service = data
    ? Array.isArray(data.recurring_services)
      ? data.recurring_services[0]
      : data.recurring_services
    : null;

  if (!data || service?.company_id !== companyId) {
    return "Occurrence not found.";
  }

  if (data.status !== expectedStatus) {
    return "This occurrence is no longer in the expected state -- someone may have already updated it. Refresh and try again.";
  }

  return null;
}

export async function markOccurrenceInvoiced(
  companyId: string,
  occurrenceId: string,
): Promise<MarkOccurrenceResult> {
  const supabase = await createClient();

  const checkError = await assertOccurrenceInCompany(
    supabase,
    companyId,
    occurrenceId,
    "pending_invoice",
  );
  if (checkError) {
    return { error: checkError };
  }

  const { error } = await supabase
    .from("recurring_service_occurrences")
    .update({ status: "invoiced", invoiced_at: todayIsoDate() })
    .eq("id", occurrenceId)
    .eq("status", "pending_invoice");

  if (error) {
    console.error(error);
    return { error: "Something went wrong. Please try again." };
  }

  revalidatePath(`/companies/${companyId}/recurring-services/pending`);
  return { error: null };
}

export async function markOccurrenceCollected(
  companyId: string,
  occurrenceId: string,
): Promise<MarkOccurrenceResult> {
  const supabase = await createClient();

  const checkError = await assertOccurrenceInCompany(
    supabase,
    companyId,
    occurrenceId,
    "invoiced",
  );
  if (checkError) {
    return { error: checkError };
  }

  const { error } = await supabase
    .from("recurring_service_occurrences")
    .update({ status: "collected", collected_at: todayIsoDate() })
    .eq("id", occurrenceId)
    .eq("status", "invoiced");

  if (error) {
    console.error(error);
    return { error: "Something went wrong. Please try again." };
  }

  revalidatePath(`/companies/${companyId}/recurring-services/pending`);
  return { error: null };
}
