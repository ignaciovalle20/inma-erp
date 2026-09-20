"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { describeTechnicianError, parseTechnicianProfile } from "@/lib/technicians";

export type EditPersonnelState = {
  error: string | null;
};

const TYPES = ["employee", "partner", "contractor"];

export async function updatePersonnel(
  companyId: string,
  personnelId: string,
  _prevState: EditPersonnelState,
  formData: FormData,
): Promise<EditPersonnelState> {
  const text = (fieldName: string) => {
    const value = formData.get(fieldName);
    return typeof value === "string" ? value : "";
  };

  const name = text("name");
  const type = text("type");
  const active = formData.get("active") === "on";

  if (!name.trim()) {
    return { error: "El nombre es obligatorio." };
  }

  if (!TYPES.includes(type)) {
    return { error: "Elegí un tipo válido." };
  }

  // Only an external technician has a ficha; for the rest those columns stay untouched.
  let profile: Record<string, unknown> = {};
  if (type === "contractor") {
    const parsed = parseTechnicianProfile(text);
    if (!parsed.ok) {
      return { error: parsed.error };
    }
    profile = parsed.value;
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
        ...profile,
      })
      .eq("id", personnelId)
      .eq("company_id", companyId)
      .select("id");

    if (error) {
      console.error(error);
      return { error: describeTechnicianError(error.message) };
    }

    if (!data || data.length === 0) {
      return { error: "No tenés permiso para editar a esta persona." };
    }
  } catch (error) {
    console.error(error);
    return { error: error instanceof Error ? error.message : "No se pudo guardar la persona." };
  }

  redirect(`/companies/${companyId}/personnel`);
}
