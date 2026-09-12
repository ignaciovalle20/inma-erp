"use server";

import { redirect } from "next/navigation";
import { createClient as createSupabaseClient } from "@/lib/supabase/server";
import { findSimilarClients } from "@/lib/dal";

export type CreateClientState = {
  error: string | null;
  warning: { matches: string[]; checkedName: string } | null;
  values: {
    name: string;
    tax_id: string;
    country: string;
    notes: string;
  };
};

export async function createClient(
  companyId: string,
  _prevState: CreateClientState,
  formData: FormData,
): Promise<CreateClientState> {
  const name = formData.get("name");
  const taxId = formData.get("tax_id");
  const country = formData.get("country");
  const notes = formData.get("notes");
  const confirmedName = formData.get("confirmedName");

  const values = {
    name: typeof name === "string" ? name : "",
    tax_id: typeof taxId === "string" ? taxId : "",
    country: typeof country === "string" ? country : "",
    notes: typeof notes === "string" ? notes : "",
  };

  if (typeof name !== "string" || !name.trim()) {
    return { error: "Client name is required.", warning: null, values };
  }

  const trimmedName = name.trim();

  const confirmed =
    formData.get("confirmed") === "true" &&
    typeof confirmedName === "string" &&
    confirmedName === trimmedName;

  if (!confirmed) {
    const similar = await findSimilarClients(companyId, trimmedName);

    if (similar.length > 0) {
      return {
        error: null,
        warning: {
          matches: similar.map((client) => client.name),
          checkedName: trimmedName,
        },
        values,
      };
    }
  }

  const supabase = await createSupabaseClient();

  try {
    const { error } = await supabase.from("clients").insert({
      company_id: companyId,
      name: trimmedName,
      tax_id: typeof taxId === "string" && taxId.trim() ? taxId.trim() : null,
      country:
        typeof country === "string" && country.trim() ? country.trim() : null,
      notes: typeof notes === "string" && notes.trim() ? notes.trim() : null,
    });

    if (error) {
      console.error(error);
      return {
        error: "Something went wrong. Please try again.",
        warning: null,
        values,
      };
    }
  } catch (error) {
    console.error(error);
    return {
      error: "Something went wrong. Please try again.",
      warning: null,
      values,
    };
  }

  redirect(`/companies/${companyId}/clients`);
}
