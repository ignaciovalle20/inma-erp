"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  getCompanyForEdit,
  getProjectForEdit,
  projectHasMovements,
  validateProjectRefs,
  type ProjectStatus,
} from "@/lib/dal";
import { companyConfig } from "@/lib/companyConfig";
import {
  PROJECT_CURRENCY_LOCKED_MESSAGE,
  projectCurrencyDbErrorMessage,
  projectCurrencyNotAllowedMessage,
  resolveProjectCurrency,
} from "@/lib/projectCurrency";
import { PROJECT_STATUSES } from "@/lib/projectStatus";
import { safeRedirect } from "@/lib/costDocumentDeletion";

export type EditProjectState = {
  error: string | null;
};

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
  const quotedAmount = formData.get("quoted_amount");
  const costBudget = formData.get("cost_budget");
  const responsible = formData.get("responsible");
  const invoiceable = formData.get("invoiceable") === "on";
  const holdReason = formData.get("hold_reason");

  if (typeof name !== "string" || !name.trim()) {
    return { error: "Project name is required." };
  }

  if (typeof clientId !== "string" || !clientId) {
    return { error: "Please select a client." };
  }

  if (typeof businessAreaId !== "string" || !businessAreaId) {
    return { error: "Please select a business area." };
  }

  if (typeof status !== "string" || !PROJECT_STATUSES.includes(status as ProjectStatus)) {
    return { error: "Invalid status." };
  }

  const trimmedHoldReason =
    typeof holdReason === "string" && holdReason.trim() ? holdReason.trim() : null;

  if (status === "en_espera" && !trimmedHoldReason) {
    return { error: "El estado \"en espera\" necesita un motivo." };
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

    // The quote and the cost budget are two different amounts (point 4 of
    // docs/verificacion-contable-2026-10-04.md); projects.budget is no longer written.
    const amount = (value: FormDataEntryValue | null) =>
      typeof value === "string" && value.trim() ? Number(value) : null;
    const trimmedQuotedAmount = amount(quotedAmount);
    const trimmedCostBudget = amount(costBudget);

    for (const [value, label] of [
      [trimmedQuotedAmount, "El monto cotizado"],
      [trimmedCostBudget, "El presupuesto de costo"],
    ] as const) {
      if (value !== null && !Number.isFinite(value)) {
        return { error: `${label} debe ser un número.` };
      }
      if (value !== null && value < 0) {
        return { error: `${label} debe ser positivo.` };
      }
    }

    // The job's currency (lib/projectCurrency.ts): only written when it
    // changes, and only to one of the company's currencies; a job with
    // movements keeps its own (the trigger projects_set_currency refuses it
    // too, this only gives the message first).
    const [membership, current] = await Promise.all([
      getCompanyForEdit(companyId),
      getProjectForEdit(companyId, projectId),
    ]);
    if (!membership || !current) {
      return { error: "You don't have permission to edit this project." };
    }
    const config = companyConfig(membership.company);
    const submittedCurrency = formData.get("currency");
    let currencyChange: string | null = null;
    if (
      typeof submittedCurrency === "string" &&
      submittedCurrency.trim() &&
      submittedCurrency.trim().toUpperCase() !== current.currency
    ) {
      currencyChange = resolveProjectCurrency(config, submittedCurrency);
      if (!currencyChange) {
        return { error: projectCurrencyNotAllowedMessage(config) };
      }
      if (currencyChange === current.currency) {
        currencyChange = null;
      } else if (await projectHasMovements(projectId)) {
        return { error: PROJECT_CURRENCY_LOCKED_MESSAGE };
      }
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
        quoted_amount: trimmedQuotedAmount,
        cost_budget: trimmedCostBudget,
        responsible:
          typeof responsible === "string" && responsible.trim()
            ? responsible.trim()
            : null,
        invoiceable,
        hold_reason: status === "en_espera" ? trimmedHoldReason : null,
        ...(currencyChange ? { currency: currencyChange } : {}),
      })
      .eq("id", projectId)
      .eq("company_id", companyId)
      .select("id");

    if (error) {
      console.error(error);
      return {
        error: projectCurrencyDbErrorMessage(error, config) ?? "Something went wrong. Please try again.",
      };
    }

    if (!data || data.length === 0) {
      return { error: "You don't have permission to edit this project." };
    }
  } catch (error) {
    console.error(error);
    return { error: "Something went wrong. Please try again." };
  }

  // Back where it was opened from, with its filters; else the job just saved.
  const volver = formData.get("volver");
  redirect(safeRedirect(companyId, typeof volver === "string" ? volver : null) ?? `/companies/${companyId}/projects/${projectId}`);
}
