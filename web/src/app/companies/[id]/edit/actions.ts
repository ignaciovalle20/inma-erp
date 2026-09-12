"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { CURRENCIES } from "@/lib/currencies";

export type EditCompanyState = {
  error: string | null;
};

export async function updateCompany(
  companyId: string,
  _prevState: EditCompanyState,
  formData: FormData,
): Promise<EditCompanyState> {
  const name = formData.get("name");
  const country = formData.get("country");
  const taxId = formData.get("tax_id");
  const currency = formData.get("currency");
  const active = formData.get("active") === "on";

  if (typeof name !== "string" || !name.trim()) {
    return { error: "Company name is required." };
  }

  if (
    typeof currency !== "string" ||
    !CURRENCIES.includes(currency as (typeof CURRENCIES)[number])
  ) {
    return { error: "Currency must be CLP, UYU, or USD." };
  }

  const supabase = await createClient();

  // Relies on RLS (the admin-only UPDATE policy) to reject non-admins --
  // no membership/role check here. A non-admin's update matches zero
  // rows rather than erroring, which we surface as a generic message.
  try {
    const { data, error } = await supabase
      .from("companies")
      .update({
        name: name.trim(),
        country: typeof country === "string" && country.trim() ? country.trim() : null,
        tax_id: typeof taxId === "string" && taxId.trim() ? taxId.trim() : null,
        currency,
        active,
      })
      .eq("id", companyId)
      .select("id");

    if (error) {
      console.error(error);
      return { error: "Something went wrong. Please try again." };
    }

    if (!data || data.length === 0) {
      return { error: "You don't have permission to edit this company." };
    }
  } catch (error) {
    console.error(error);
    return { error: "Something went wrong. Please try again." };
  }

  redirect("/companies");
}
