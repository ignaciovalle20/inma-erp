"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export type CreateRecurringServiceState = {
  error: string | null;
  values: {
    client_id: string;
    name: string;
    price: string;
    expected_cost: string;
    currency: string;
    periodicity: string;
    start_date: string;
    end_date: string;
  };
};

const CURRENCIES = ["CLP", "UYU", "USD"];
const PERIODICITIES = ["monthly", "annual"];

export async function createRecurringService(
  companyId: string,
  _prevState: CreateRecurringServiceState,
  formData: FormData,
): Promise<CreateRecurringServiceState> {
  const clientId = formData.get("client_id");
  const name = formData.get("name");
  const price = formData.get("price");
  const expectedCost = formData.get("expected_cost");
  const currency = formData.get("currency");
  const periodicity = formData.get("periodicity");
  const startDate = formData.get("start_date");
  const endDate = formData.get("end_date");

  const values = {
    client_id: typeof clientId === "string" ? clientId : "",
    name: typeof name === "string" ? name : "",
    price: typeof price === "string" ? price : "",
    expected_cost: typeof expectedCost === "string" ? expectedCost : "",
    currency: typeof currency === "string" ? currency : "",
    periodicity: typeof periodicity === "string" ? periodicity : "monthly",
    start_date: typeof startDate === "string" ? startDate : "",
    end_date: typeof endDate === "string" ? endDate : "",
  };

  if (typeof clientId !== "string" || !clientId) {
    return { error: "Please select a client.", values };
  }

  if (typeof name !== "string" || !name.trim()) {
    return { error: "Service name is required.", values };
  }

  const parsedPrice = typeof price === "string" ? Number(price) : NaN;

  if (typeof price !== "string" || !price.trim() || !Number.isFinite(parsedPrice)) {
    return { error: "Price must be a number.", values };
  }

  const parsedExpectedCost =
    typeof expectedCost === "string" && expectedCost.trim()
      ? Number(expectedCost)
      : 0;

  if (!Number.isFinite(parsedExpectedCost)) {
    return { error: "Expected cost must be a number.", values };
  }

  if (typeof currency !== "string" || !CURRENCIES.includes(currency)) {
    return { error: "Please select a valid currency.", values };
  }

  if (typeof periodicity !== "string" || !PERIODICITIES.includes(periodicity)) {
    return { error: "Please select a valid periodicity.", values };
  }

  if (typeof startDate !== "string" || !startDate.trim()) {
    return { error: "Start date is required.", values };
  }

  const trimmedEndDate =
    typeof endDate === "string" && endDate.trim() ? endDate.trim() : null;

  if (trimmedEndDate && trimmedEndDate < startDate.trim()) {
    return {
      error: "End date must be on or after the start date.",
      values,
    };
  }

  const supabase = await createClient();

  // Server-side cross-company validation: the selected client must
  // exist AND belong to this companyId -- never trust the UI only
  // offered valid options. Defense-in-depth alongside the DB-level
  // recurring_services_validate_company_refs trigger, which is the
  // real guarantee; this check just gives a friendlier error message.
  const { data: client, error: clientError } = await supabase
    .from("clients")
    .select("id")
    .eq("id", clientId)
    .eq("company_id", companyId)
    .maybeSingle();

  if (clientError) {
    console.error(clientError);
    return { error: "Something went wrong. Please try again.", values };
  }

  if (!client) {
    return {
      error: "Selected client does not belong to this company.",
      values,
    };
  }

  try {
    const { error } = await supabase.from("recurring_services").insert({
      company_id: companyId,
      client_id: clientId,
      name: name.trim(),
      price: parsedPrice,
      expected_cost: parsedExpectedCost,
      currency,
      periodicity,
      start_date: startDate.trim(),
      end_date: trimmedEndDate,
    });

    if (error) {
      console.error(error);
      return {
        error: "Something went wrong. Please try again.",
        values,
      };
    }
  } catch (error) {
    console.error(error);
    return {
      error: "Something went wrong. Please try again.",
      values,
    };
  }

  redirect(`/companies/${companyId}/recurring-services`);
}
