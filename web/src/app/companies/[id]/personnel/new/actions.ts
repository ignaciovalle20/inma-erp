"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  describeTechnicianError,
  parseTechnicianProfile,
  readTechnicianFormValues,
  type TechnicianFormValues,
} from "@/lib/technicians";

export type CreatePersonnelState = {
  error: string | null;
  values: {
    name: string;
    type: string;
  } & TechnicianFormValues;
};

const TYPES = ["employee", "partner", "contractor"];

export async function createPersonnel(
  companyId: string,
  _prevState: CreatePersonnelState,
  formData: FormData,
): Promise<CreatePersonnelState> {
  const text = (fieldName: string) => {
    const value = formData.get(fieldName);
    return typeof value === "string" ? value : "";
  };

  const values = {
    name: text("name"),
    type: text("type") || "employee",
    ...readTechnicianFormValues(text),
  };

  if (!values.name.trim()) {
    return { error: "El nombre es obligatorio.", values };
  }

  if (!TYPES.includes(values.type)) {
    return { error: "Elegí un tipo válido.", values };
  }

  // The ficha (RUT, document, rates, payment details) only exists for external technicians.
  let profile: Record<string, unknown> = {};
  if (values.type === "contractor") {
    const parsed = parseTechnicianProfile(text);
    if (!parsed.ok) {
      return { error: parsed.error, values };
    }
    profile = parsed.value;
  }

  const supabase = await createClient();

  try {
    const { error } = await supabase.from("personnel").insert({
      company_id: companyId,
      name: values.name.trim(),
      type: values.type,
      ...profile,
    });

    if (error) {
      console.error(error);
      return { error: describeTechnicianError(error.message), values };
    }
  } catch (error) {
    console.error(error);
    return {
      error: error instanceof Error ? error.message : "No se pudo crear la persona.",
      values,
    };
  }

  redirect(`/companies/${companyId}/personnel`);
}
