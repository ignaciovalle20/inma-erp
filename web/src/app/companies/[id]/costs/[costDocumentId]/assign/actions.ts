"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export type AssignCostDocumentState = {
  error: string | null;
  values: { project_id: string };
};

export async function assignCostDocumentToProject(
  companyId: string,
  costDocumentId: string,
  _prevState: AssignCostDocumentState,
  formData: FormData,
): Promise<AssignCostDocumentState> {
  const projectId = formData.get("project_id");

  const values = { project_id: typeof projectId === "string" ? projectId : "" };

  if (typeof projectId !== "string" || !projectId.trim()) {
    return { error: "Elegí un trabajo.", values };
  }

  const supabase = await createClient();

  const { error } = await supabase.rpc("assign_cost_document_to_project", {
    p_cost_document_id: costDocumentId,
    p_project_id: projectId.trim(),
  });

  if (error) {
    console.error(error);
    return {
      error: "No se pudo asignar el costo. Probá de nuevo.",
      values,
    };
  }

  redirect(`/companies/${companyId}/costs`);
}
