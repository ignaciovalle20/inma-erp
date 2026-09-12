"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export type EditClientState = {
  error: string | null;
};

export async function updateClient(
  companyId: string,
  clientId: string,
  _prevState: EditClientState,
  formData: FormData,
): Promise<EditClientState> {
  const name = formData.get("name");
  const taxId = formData.get("tax_id");
  const country = formData.get("country");
  const notes = formData.get("notes");
  const active = formData.get("active") === "on";

  if (typeof name !== "string" || !name.trim()) {
    return { error: "Client name is required." };
  }

  const supabase = await createClient();

  // Relies on RLS (any-member UPDATE policy scoped to company_id) to
  // reject non-members -- no membership check here. A non-member's
  // update matches zero rows rather than erroring.
  try {
    const { data, error } = await supabase
      .from("clients")
      .update({
        name: name.trim(),
        tax_id: typeof taxId === "string" && taxId.trim() ? taxId.trim() : null,
        country:
          typeof country === "string" && country.trim()
            ? country.trim()
            : null,
        notes: typeof notes === "string" && notes.trim() ? notes.trim() : null,
        active,
      })
      .eq("id", clientId)
      .eq("company_id", companyId)
      .select("id");

    if (error) {
      console.error(error);
      return { error: "Something went wrong. Please try again." };
    }

    if (!data || data.length === 0) {
      return { error: "You don't have permission to edit this client." };
    }
  } catch (error) {
    console.error(error);
    return { error: "Something went wrong. Please try again." };
  }

  redirect(`/companies/${companyId}/clients`);
}
