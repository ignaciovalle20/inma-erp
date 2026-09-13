"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export type EditPersonnelState = {
  error: string | null;
};

const TYPES = ["employee", "partner"];

export async function updatePersonnel(
  companyId: string,
  personnelId: string,
  _prevState: EditPersonnelState,
  formData: FormData,
): Promise<EditPersonnelState> {
  const name = formData.get("name");
  const type = formData.get("type");
  const active = formData.get("active") === "on";

  if (typeof name !== "string" || !name.trim()) {
    return { error: "Name is required." };
  }

  if (typeof type !== "string" || !TYPES.includes(type)) {
    return { error: "Please select a valid type." };
  }

  const supabase = await createClient();

  // Relies on RLS (any-member UPDATE policy scoped to company_id) to
  // reject non-members -- no membership check here. A non-member's
  // update matches zero rows rather than erroring.
  try {
    const { data, error } = await supabase
      .from("personnel")
      .update({
        name: name.trim(),
        type,
        active,
      })
      .eq("id", personnelId)
      .eq("company_id", companyId)
      .select("id");

    if (error) {
      console.error(error);
      return { error: "Something went wrong. Please try again." };
    }

    if (!data || data.length === 0) {
      return { error: "You don't have permission to edit this person." };
    }
  } catch (error) {
    console.error(error);
    return { error: "Something went wrong. Please try again." };
  }

  redirect(`/companies/${companyId}/personnel`);
}
