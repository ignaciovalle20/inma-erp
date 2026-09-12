"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { validateProjectRefs } from "@/lib/dal";

export type CreateProjectState = {
  error: string | null;
  values: {
    name: string;
    client_id: string;
    business_area_id: string;
    start_date: string;
    end_date: string;
    budget: string;
    responsible: string;
  };
};

export async function createProject(
  companyId: string,
  _prevState: CreateProjectState,
  formData: FormData,
): Promise<CreateProjectState> {
  const name = formData.get("name");
  const clientId = formData.get("client_id");
  const businessAreaId = formData.get("business_area_id");
  const startDate = formData.get("start_date");
  const endDate = formData.get("end_date");
  const budget = formData.get("budget");
  const responsible = formData.get("responsible");

  const values = {
    name: typeof name === "string" ? name : "",
    client_id: typeof clientId === "string" ? clientId : "",
    business_area_id:
      typeof businessAreaId === "string" ? businessAreaId : "",
    start_date: typeof startDate === "string" ? startDate : "",
    end_date: typeof endDate === "string" ? endDate : "",
    budget: typeof budget === "string" ? budget : "",
    responsible: typeof responsible === "string" ? responsible : "",
  };

  if (typeof name !== "string" || !name.trim()) {
    return { error: "Project name is required.", values };
  }

  if (typeof clientId !== "string" || !clientId) {
    return { error: "Please select a client.", values };
  }

  if (typeof businessAreaId !== "string" || !businessAreaId) {
    return { error: "Please select a business area.", values };
  }

  const supabase = await createClient();

  // Server-side cross-company validation: the selected client and
  // business area must both exist AND belong to this same companyId --
  // never trust that the UI only offered valid options (a tampered
  // request could submit any id). This is defense-in-depth alongside
  // the DB-level `projects_validate_company_refs` trigger, which is the
  // real guarantee; this check just gives a friendlier error message.
  try {
    const refsResult = await validateProjectRefs(
      companyId,
      clientId,
      businessAreaId,
    );

    if (refsResult.error === "lookup_failed") {
      console.error(refsResult.detail);
      return {
        error: "Something went wrong. Please try again.",
        values,
      };
    }

    if (refsResult.error === "client") {
      return {
        error: "Selected client does not belong to this company.",
        values,
      };
    }

    if (refsResult.error === "business_area") {
      return {
        error: "Selected business area does not belong to this company.",
        values,
      };
    }

    if (
      typeof startDate === "string" &&
      startDate.trim() &&
      typeof endDate === "string" &&
      endDate.trim() &&
      endDate.trim() < startDate.trim()
    ) {
      return {
        error: "End date must be on or after the start date.",
        values,
      };
    }

    const trimmedBudget =
      typeof budget === "string" && budget.trim() ? Number(budget) : null;

    if (trimmedBudget !== null && !Number.isFinite(trimmedBudget)) {
      return { error: "Budget must be a number.", values };
    }

    if (trimmedBudget !== null && trimmedBudget < 0) {
      return { error: "Budget must be a positive number.", values };
    }

    const { error } = await supabase.from("projects").insert({
      company_id: companyId,
      client_id: clientId,
      business_area_id: businessAreaId,
      name: name.trim(),
      start_date:
        typeof startDate === "string" && startDate.trim()
          ? startDate.trim()
          : null,
      end_date:
        typeof endDate === "string" && endDate.trim() ? endDate.trim() : null,
      budget: trimmedBudget,
      responsible:
        typeof responsible === "string" && responsible.trim()
          ? responsible.trim()
          : null,
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

  redirect(`/companies/${companyId}/projects`);
}
