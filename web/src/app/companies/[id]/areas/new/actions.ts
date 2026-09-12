"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export type CreateBusinessAreaState = {
  error: string | null;
  values: {
    name: string;
  };
};

export async function createBusinessArea(
  companyId: string,
  _prevState: CreateBusinessAreaState,
  formData: FormData,
): Promise<CreateBusinessAreaState> {
  const name = formData.get("name");

  const values = {
    name: typeof name === "string" ? name : "",
  };

  if (typeof name !== "string" || !name.trim()) {
    return { error: "Area name is required.", values };
  }

  const supabase = await createClient();

  // Relies on RLS (the admin-only INSERT policy) to reject non-admins --
  // no membership/role check here beyond the page-level redirect.
  try {
    const trimmedName = name.trim();

    const { data: existing, error: lookupError } = await supabase
      .from("business_areas")
      .select("id")
      .eq("company_id", companyId)
      .ilike("name", trimmedName)
      .maybeSingle();

    if (lookupError) {
      console.error(lookupError);
      return {
        error: "Something went wrong. Please try again.",
        values,
      };
    }

    if (existing) {
      return {
        error: `An area named '${trimmedName}' already exists.`,
        values,
      };
    }

    const { error } = await supabase.from("business_areas").insert({
      company_id: companyId,
      name: name.trim(),
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

  redirect(`/companies/${companyId}/areas`);
}
