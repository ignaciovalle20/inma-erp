"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export type EditRecurringServiceState = {
  error: string | null;
};

const CURRENCIES = ["CLP", "UYU", "USD"];
const PERIODICITIES = ["monthly", "annual"];

export async function updateRecurringService(
  companyId: string,
  recurringServiceId: string,
  _prevState: EditRecurringServiceState,
  formData: FormData,
): Promise<EditRecurringServiceState> {
  const clientId = formData.get("client_id");
  const name = formData.get("name");
  const price = formData.get("price");
  const expectedCost = formData.get("expected_cost");
  const currency = formData.get("currency");
  const periodicity = formData.get("periodicity");
  const startDate = formData.get("start_date");
  const endDate = formData.get("end_date");
  const active = formData.get("active") === "on";

  if (typeof clientId !== "string" || !clientId) {
    return { error: "Please select a client." };
  }

  if (typeof name !== "string" || !name.trim()) {
    return { error: "Service name is required." };
  }

  const parsedPrice = typeof price === "string" ? Number(price) : NaN;

  if (typeof price !== "string" || !price.trim() || !Number.isFinite(parsedPrice)) {
    return { error: "Price must be a number." };
  }

  const parsedExpectedCost =
    typeof expectedCost === "string" && expectedCost.trim()
      ? Number(expectedCost)
      : 0;

  if (!Number.isFinite(parsedExpectedCost)) {
    return { error: "Expected cost must be a number." };
  }

  if (typeof currency !== "string" || !CURRENCIES.includes(currency)) {
    return { error: "Please select a valid currency." };
  }

  if (typeof periodicity !== "string" || !PERIODICITIES.includes(periodicity)) {
    return { error: "Please select a valid periodicity." };
  }

  if (typeof startDate !== "string" || !startDate.trim()) {
    return { error: "Start date is required." };
  }

  const trimmedEndDate =
    typeof endDate === "string" && endDate.trim() ? endDate.trim() : null;

  if (trimmedEndDate && trimmedEndDate < startDate.trim()) {
    return { error: "End date must be on or after the start date." };
  }

  const supabase = await createClient();

  // Server-side cross-company validation, same reasoning as the create
  // action: never trust the UI only offered valid options. Defense-in-
  // depth alongside the DB-level recurring_services_validate_company_refs
  // trigger.
  const { data: client, error: clientError } = await supabase
    .from("clients")
    .select("id")
    .eq("id", clientId)
    .eq("company_id", companyId)
    .maybeSingle();

  if (clientError) {
    console.error(clientError);
    return { error: "Something went wrong. Please try again." };
  }

  if (!client) {
    return { error: "Selected client does not belong to this company." };
  }

  // Relies on RLS (any-member UPDATE policy scoped to company_id) to
  // reject non-members -- no membership check here. A non-member's
  // update matches zero rows rather than erroring.
  try {
    const { data, error } = await supabase
      .from("recurring_services")
      .update({
        client_id: clientId,
        name: name.trim(),
        price: parsedPrice,
        expected_cost: parsedExpectedCost,
        currency,
        periodicity,
        start_date: startDate.trim(),
        end_date: trimmedEndDate,
        active,
      })
      .eq("id", recurringServiceId)
      .eq("company_id", companyId)
      .select("id");

    if (error) {
      console.error(error);
      return { error: "Something went wrong. Please try again." };
    }

    if (!data || data.length === 0) {
      return {
        error: "You don't have permission to edit this recurring service.",
      };
    }
  } catch (error) {
    console.error(error);
    return { error: "Something went wrong. Please try again." };
  }

  redirect(`/companies/${companyId}/recurring-services`);
}
