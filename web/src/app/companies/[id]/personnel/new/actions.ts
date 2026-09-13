"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export type CreatePersonnelState = {
  error: string | null;
  values: {
    name: string;
    type: string;
  };
};

const TYPES = ["employee", "partner"];

export async function createPersonnel(
  companyId: string,
  _prevState: CreatePersonnelState,
  formData: FormData,
): Promise<CreatePersonnelState> {
  const name = formData.get("name");
  const type = formData.get("type");

  const values = {
    name: typeof name === "string" ? name : "",
    type: typeof type === "string" ? type : "employee",
  };

  if (typeof name !== "string" || !name.trim()) {
    return { error: "Name is required.", values };
  }

  if (typeof type !== "string" || !TYPES.includes(type)) {
    return { error: "Please select a valid type.", values };
  }

  const supabase = await createClient();

  try {
    const { error } = await supabase.from("personnel").insert({
      company_id: companyId,
      name: name.trim(),
      type,
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

  redirect(`/companies/${companyId}/personnel`);
}
