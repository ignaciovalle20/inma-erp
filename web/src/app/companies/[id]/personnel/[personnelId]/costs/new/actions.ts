"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { MONTH_PATTERN } from "@/lib/period";

export type CreatePersonnelCostState = {
  error: string | null;
  values: {
    period: string;
    amount: string;
    currency: string;
  };
};

const CURRENCIES = ["CLP", "UYU", "USD"];

export async function createPersonnelCost(
  companyId: string,
  personnelId: string,
  _prevState: CreatePersonnelCostState,
  formData: FormData,
): Promise<CreatePersonnelCostState> {
  const period = formData.get("period");
  const amount = formData.get("amount");
  const currency = formData.get("currency");

  const values = {
    period: typeof period === "string" ? period : "",
    amount: typeof amount === "string" ? amount : "",
    currency: typeof currency === "string" ? currency : "",
  };

  if (typeof period !== "string" || !period.trim()) {
    return { error: "Period is required.", values };
  }

  // <input type="month"> yields "YYYY-MM" -- normalize to the first of
  // the month to match the DB's period check constraint.
  const normalizedPeriod = MONTH_PATTERN.test(period.trim())
    ? `${period.trim()}-01`
    : period.trim();

  const parsedAmount = typeof amount === "string" ? Number(amount) : NaN;

  if (
    typeof amount !== "string" ||
    !amount.trim() ||
    !Number.isFinite(parsedAmount)
  ) {
    return { error: "Amount must be a number.", values };
  }

  if (typeof currency !== "string" || !CURRENCIES.includes(currency)) {
    return { error: "Please select a valid currency.", values };
  }

  const supabase = await createClient();

  // Server-side "person belongs to this company" check -- never trust
  // the UI only offered a valid personnelId. RLS (join through
  // personnel.company_id) is the real guarantee; this just gives a
  // friendlier error and confirms the person exists before the insert.
  const { data: person, error: personError } = await supabase
    .from("personnel")
    .select("id")
    .eq("id", personnelId)
    .eq("company_id", companyId)
    .maybeSingle();

  if (personError) {
    console.error(personError);
    return { error: "Something went wrong. Please try again.", values };
  }

  if (!person) {
    return {
      error: "Selected person does not belong to this company.",
      values,
    };
  }

  // Pre-check for an existing (personnel_id, period) record so a
  // duplicate attempt gets a clear message rather than a raw DB unique-
  // constraint error (same approach as business_areas' name check).
  const { data: existing, error: lookupError } = await supabase
    .from("personnel_costs")
    .select("id")
    .eq("personnel_id", personnelId)
    .eq("period", normalizedPeriod)
    .maybeSingle();

  if (lookupError) {
    console.error(lookupError);
    return { error: "Something went wrong. Please try again.", values };
  }

  if (existing) {
    return {
      error:
        "A cost record for this person and period already exists. Edit that record instead of adding a new one.",
      values,
    };
  }

  try {
    const { error } = await supabase.from("personnel_costs").insert({
      personnel_id: personnelId,
      period: normalizedPeriod,
      amount: parsedAmount,
      currency,
    });

    if (error) {
      console.error(error);
      // A duplicate could still slip through a race between the
      // pre-check and this insert -- the unique constraint is the real
      // guarantee, this just gives a friendlier message for that case.
      if (error.code === "23505") {
        return {
          error:
            "A cost record for this person and period already exists. Edit that record instead of adding a new one.",
          values,
        };
      }
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

  redirect(`/companies/${companyId}/personnel/${personnelId}/costs`);
}
