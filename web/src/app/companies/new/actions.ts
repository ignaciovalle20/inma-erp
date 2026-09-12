"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { CURRENCIES } from "@/lib/currencies";

export type CreateCompanyState = {
  error: string | null;
};

export async function createCompany(
  _prevState: CreateCompanyState,
  formData: FormData,
): Promise<CreateCompanyState> {
  const name = formData.get("name");
  const country = formData.get("country");
  const taxId = formData.get("tax_id");
  const currency = formData.get("currency");

  if (typeof name !== "string" || !name.trim()) {
    return { error: "Company name is required." };
  }

  if (typeof currency !== "string" || !CURRENCIES.includes(currency as (typeof CURRENCIES)[number])) {
    return { error: "Currency must be CLP, UYU, or USD." };
  }

  const supabase = await createClient();

  try {
    const { error } = await supabase.rpc("create_company", {
      p_name: name.trim(),
      p_country: typeof country === "string" && country.trim() ? country.trim() : null,
      p_tax_id: typeof taxId === "string" && taxId.trim() ? taxId.trim() : null,
      p_currency: currency,
    });

    if (error) {
      console.error(error);
      return { error: "Something went wrong. Please try again." };
    }
  } catch (error) {
    console.error(error);
    return { error: "Something went wrong. Please try again." };
  }

  redirect("/companies");
}
