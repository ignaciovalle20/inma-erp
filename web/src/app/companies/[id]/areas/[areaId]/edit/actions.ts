"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export type EditBusinessAreaState = {
  error: string | null;
};

export async function updateBusinessArea(
  companyId: string,
  areaId: string,
  _prevState: EditBusinessAreaState,
  formData: FormData,
): Promise<EditBusinessAreaState> {
  const name = formData.get("name");
  const active = formData.get("active") === "on";

  if (typeof name !== "string" || !name.trim()) {
    return { error: "Area name is required." };
  }

  const supabase = await createClient();

  // Relies on RLS (the admin-only UPDATE policy) to reject non-admins --
  // the page above also redirects non-admins before this can be called.
  try {
    const trimmedName = name.trim();

    const { data: existing, error: lookupError } = await supabase
      .from("business_areas")
      .select("id")
      .eq("company_id", companyId)
      .ilike("name", trimmedName)
      .neq("id", areaId)
      .maybeSingle();

    if (lookupError) {
      console.error(lookupError);
      return { error: "Something went wrong. Please try again." };
    }

    if (existing) {
      return { error: `An area named '${trimmedName}' already exists.` };
    }

    const { data, error } = await supabase
      .from("business_areas")
      .update({
        name: trimmedName,
        active,
      })
      .eq("id", areaId)
      .eq("company_id", companyId)
      .select("id");

    if (error) {
      console.error(error);
      return { error: "Something went wrong. Please try again." };
    }

    if (!data || data.length === 0) {
      return { error: "You don't have permission to edit this area." };
    }
  } catch (error) {
    console.error(error);
    return { error: "Something went wrong. Please try again." };
  }

  redirect(`/companies/${companyId}/areas`);
}
