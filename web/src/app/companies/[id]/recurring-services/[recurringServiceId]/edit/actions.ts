"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  SERVICE_TYPES,
  INVOICING_MODES,
  RECURRING_SERVICE_STATUSES,
  type ServiceType,
  type RecurringServiceStatus,
} from "@/lib/recurringServiceTypes";

export type EditRecurringServiceState = {
  error: string | null;
};

const CURRENCIES = ["CLP", "UYU", "USD"];
const PERIODICITIES = ["monthly", "annual"];

export async function updateRecurringService(
  companyId: string,
  recurringServiceId: string,
  _prevState: EditRecurringServiceState,
  formData: FormData,
): Promise<EditRecurringServiceState> {
  const clientId = formData.get("client_id");
  const name = formData.get("name");
  const price = formData.get("price");
  const expectedCost = formData.get("expected_cost");
  const currency = formData.get("currency");
  const periodicity = formData.get("periodicity");
  const startDate = formData.get("start_date");
  const endDate = formData.get("end_date");
  const status = formData.get("status");
  const businessAreaId = formData.get("business_area_id");
  const serviceType = formData.get("service_type");
  const invoicingMode = formData.get("invoicing_mode");
  const dueDay = formData.get("due_day");
  const dueMonth = formData.get("due_month");
  const fixedMonthlyCost = formData.get("fixed_monthly_cost");
  const usesCostPool = formData.get("uses_cost_pool") === "on";
  const quoteRef = formData.get("quote_ref");

  if (typeof clientId !== "string" || !clientId) {
    return { error: "Please select a client." };
  }

  if (typeof name !== "string" || !name.trim()) {
    return { error: "Service name is required." };
  }

  const parsedPrice = typeof price === "string" ? Number(price) : NaN;

  if (typeof price !== "string" || !price.trim() || !Number.isFinite(parsedPrice)) {
    return { error: "Price must be a number." };
  }

  const parsedExpectedCost =
    typeof expectedCost === "string" && expectedCost.trim()
      ? Number(expectedCost)
      : 0;

  if (!Number.isFinite(parsedExpectedCost)) {
    return { error: "Expected cost must be a number." };
  }

  if (typeof currency !== "string" || !CURRENCIES.includes(currency)) {
    return { error: "Please select a valid currency." };
  }

  if (typeof periodicity !== "string" || !PERIODICITIES.includes(periodicity)) {
    return { error: "Please select a valid periodicity." };
  }

  if (typeof startDate !== "string" || !startDate.trim()) {
    return { error: "Start date is required." };
  }

  const trimmedEndDate =
    typeof endDate === "string" && endDate.trim() ? endDate.trim() : null;

  if (trimmedEndDate && trimmedEndDate < startDate.trim()) {
    return { error: "End date must be on or after the start date." };
  }

  if (typeof status !== "string" || !RECURRING_SERVICE_STATUSES.includes(status as RecurringServiceStatus)) {
    return { error: "Please select a valid status." };
  }

  const trimmedBusinessAreaId =
    typeof businessAreaId === "string" && businessAreaId.trim()
      ? businessAreaId.trim()
      : null;

  const trimmedServiceType =
    typeof serviceType === "string" && serviceType.trim()
      ? (serviceType.trim() as ServiceType)
      : null;

  if (trimmedServiceType && !SERVICE_TYPES.includes(trimmedServiceType)) {
    return { error: "Please select a valid service type." };
  }

  if (typeof invoicingMode !== "string" || !INVOICING_MODES.includes(invoicingMode as (typeof INVOICING_MODES)[number])) {
    return { error: "Please select a valid invoicing mode." };
  }

  const parsedDueDay =
    typeof dueDay === "string" && dueDay.trim() ? Number(dueDay) : null;

  if (parsedDueDay !== null && (!Number.isInteger(parsedDueDay) || parsedDueDay < 1 || parsedDueDay > 31)) {
    return { error: "Due day must be between 1 and 31." };
  }

  const parsedDueMonth =
    typeof dueMonth === "string" && dueMonth.trim() ? Number(dueMonth) : null;

  if (parsedDueMonth !== null && (!Number.isInteger(parsedDueMonth) || parsedDueMonth < 1 || parsedDueMonth > 12)) {
    return { error: "Due month must be between 1 and 12." };
  }

  if (periodicity === "annual" && parsedDueMonth === null) {
    return { error: "Annual services need a due month." };
  }

  const parsedFixedMonthlyCost =
    typeof fixedMonthlyCost === "string" && fixedMonthlyCost.trim()
      ? Number(fixedMonthlyCost)
      : null;

  if (parsedFixedMonthlyCost !== null && !Number.isFinite(parsedFixedMonthlyCost)) {
    return { error: "Fixed monthly cost must be a number." };
  }

  const trimmedQuoteRef =
    typeof quoteRef === "string" && quoteRef.trim() ? quoteRef.trim() : null;

  const supabase = await createClient();

  // Server-side cross-company validation, same reasoning as the create
  // action: never trust the UI only offered valid options. Defense-in-
  // depth alongside the DB-level recurring_services_validate_company_refs
  // trigger.
  const { data: client, error: clientError } = await supabase
    .from("clients")
    .select("id")
    .eq("id", clientId)
    .eq("company_id", companyId)
    .maybeSingle();

  if (clientError) {
    console.error(clientError);
    return { error: "Something went wrong. Please try again." };
  }

  if (!client) {
    return { error: "Selected client does not belong to this company." };
  }

  if (trimmedBusinessAreaId) {
    const { data: area, error: areaError } = await supabase
      .from("business_areas")
      .select("id")
      .eq("id", trimmedBusinessAreaId)
      .eq("company_id", companyId)
      .maybeSingle();

    if (areaError) {
      console.error(areaError);
      return { error: "Something went wrong. Please try again." };
    }

    if (!area) {
      return { error: "Selected business area does not belong to this company." };
    }
  }

  // `active` is derived from `status` here (Phase 5 gave `status` its
  // own Activo/Pausado/Cancelado select, replacing Phase 3's "kept in
  // sync with a checkbox" placeholder) -- both paused and cancelled
  // map to active=false, since either one should stop this service
  // from being picked up by the old manual-generate button (list
  // page's canGenerate) the same way it already stops the Phase 4
  // cron (which filters on status='active' directly).
  const nextStatus = status as RecurringServiceStatus;

  // Relies on RLS (any-member UPDATE policy scoped to company_id) to
  // reject non-members -- no membership check here. A non-member's
  // update matches zero rows rather than erroring.
  try {
    const { data, error } = await supabase
      .from("recurring_services")
      .update({
        client_id: clientId,
        name: name.trim(),
        price: parsedPrice,
        expected_cost: parsedExpectedCost,
        currency,
        periodicity,
        start_date: startDate.trim(),
        end_date: trimmedEndDate,
        active: nextStatus === "active",
        status: nextStatus,
        business_area_id: trimmedBusinessAreaId,
        service_type: trimmedServiceType,
        invoicing_mode: invoicingMode,
        due_day: parsedDueDay,
        due_month: parsedDueMonth,
        fixed_monthly_cost: parsedFixedMonthlyCost,
        uses_cost_pool: usesCostPool,
        quote_ref: trimmedQuoteRef,
      })
      .eq("id", recurringServiceId)
      .eq("company_id", companyId)
      .select("id");

    if (error) {
      console.error(error);
      return { error: "Something went wrong. Please try again." };
    }

    if (!data || data.length === 0) {
      return {
        error: "You don't have permission to edit this recurring service.",
      };
    }
  } catch (error) {
    console.error(error);
    return { error: "Something went wrong. Please try again." };
  }

  redirect(`/companies/${companyId}/recurring-services`);
}
