"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { validateProjectRefs, type ProjectStatus } from "@/lib/dal";

export type EditProjectState = {
  error: string | null;
};

const VALID_STATUSES: ProjectStatus[] = ["active", "on_hold", "closed"];

export async function updateProject(
  companyId: string,
  projectId: string,
  _prevState: EditProjectState,
  formData: FormData,
): Promise<EditProjectState> {
  const name = formData.get("name");
  const clientId = formData.get("client_id");
  const businessAreaId = formData.get("business_area_id");
  const startDate = formData.get("start_date");
  const endDate = formData.get("end_date");
  const status = formData.get("status");
  const budget = formData.get("budget");
  const responsible = formData.get("responsible");

  if (typeof name !== "string" || !name.trim()) {
    return { error: "Project name is required." };
  }

  if (typeof clientId !== "string" || !clientId) {
    return { error: "Please select a client." };
  }

  if (typeof businessAreaId !== "string" || !businessAreaId) {
    return { error: "Please select a business area." };
  }

  if (typeof status !== "string" || !VALID_STATUSES.includes(status as ProjectStatus)) {
    return { error: "Invalid status." };
  }

  const supabase = await createClient();

  // Server-side cross-company validation: the selected client and
  // business area must both exist AND belong to this same companyId,
  // even on reassignment -- never trust that the UI only offered valid
  // options (a tampered request could submit any id). This is
  // defense-in-depth alongside the DB-level
  // `projects_validate_company_refs` trigger, which is the real
  // guarantee; this check just gives a friendlier error message.
  try {
    const refsResult = await validateProjectRefs(
      companyId,
      clientId,
      businessAreaId,
    );

    if (refsResult.error === "lookup_failed") {
      console.error(refsResult.detail);
      return { error: "Something went wrong. Please try again." };
    }

    if (refsResult.error === "client") {
      return { error: "Selected client does not belong to this company." };
    }

    if (refsResult.error === "business_area") {
      return {
        error: "Selected business area does not belong to this company.",
      };
    }

    if (
      typeof startDate === "string" &&
      startDate.trim() &&
      typeof endDate === "string" &&
      endDate.trim() &&
      endDate.trim() < startDate.trim()
    ) {
      return { error: "End date must be on or after the start date." };
    }

    const trimmedBudget =
      typeof budget === "string" && budget.trim() ? Number(budget) : null;

    if (trimmedBudget !== null && !Number.isFinite(trimmedBudget)) {
      return { error: "Budget must be a number." };
    }

    if (trimmedBudget !== null && trimmedBudget < 0) {
      return { error: "Budget must be a positive number." };
    }

    // Relies on RLS (any-member UPDATE policy scoped to company_id) to
    // reject non-members -- no separate membership check here. A
    // non-member's update matches zero rows rather than erroring.
    const { data, error } = await supabase
      .from("projects")
      .update({
        name: name.trim(),
        client_id: clientId,
        business_area_id: businessAreaId,
        start_date:
          typeof startDate === "string" && startDate.trim()
            ? startDate.trim()
            : null,
        end_date:
          typeof endDate === "string" && endDate.trim()
            ? endDate.trim()
            : null,
        status,
        budget: trimmedBudget,
        responsible:
          typeof responsible === "string" && responsible.trim()
            ? responsible.trim()
            : null,
      })
      .eq("id", projectId)
      .eq("company_id", companyId)
      .select("id");

    if (error) {
      console.error(error);
      return { error: "Something went wrong. Please try again." };
    }

    if (!data || data.length === 0) {
      return { error: "You don't have permission to edit this project." };
    }
  } catch (error) {
    console.error(error);
    return { error: "Something went wrong. Please try again." };
  }

  redirect(`/companies/${companyId}/projects`);
}
