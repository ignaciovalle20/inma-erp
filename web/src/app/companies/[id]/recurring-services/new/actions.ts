"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  SERVICE_TYPES,
  INVOICING_MODES,
  type ServiceType,
} from "@/lib/recurringServiceTypes";

export type CreateRecurringServiceState = {
  error: string | null;
  values: {
    client_id: string;
    name: string;
    price: string;
    expected_cost: string;
    currency: string;
    periodicity: string;
    start_date: string;
    end_date: string;
    business_area_id: string;
    service_type: string;
    invoicing_mode: string;
    due_day: string;
    due_month: string;
    fixed_monthly_cost: string;
    uses_cost_pool: boolean;
    quote_ref: string;
  };
};

const CURRENCIES = ["CLP", "UYU", "USD"];
const PERIODICITIES = ["monthly", "annual"];

export async function createRecurringService(
  companyId: string,
  _prevState: CreateRecurringServiceState,
  formData: FormData,
): Promise<CreateRecurringServiceState> {
  const clientId = formData.get("client_id");
  const name = formData.get("name");
  const price = formData.get("price");
  const expectedCost = formData.get("expected_cost");
  const currency = formData.get("currency");
  const periodicity = formData.get("periodicity");
  const startDate = formData.get("start_date");
  const endDate = formData.get("end_date");
  const businessAreaId = formData.get("business_area_id");
  const serviceType = formData.get("service_type");
  const invoicingMode = formData.get("invoicing_mode");
  const dueDay = formData.get("due_day");
  const dueMonth = formData.get("due_month");
  const fixedMonthlyCost = formData.get("fixed_monthly_cost");
  const usesCostPool = formData.get("uses_cost_pool") === "on";
  const quoteRef = formData.get("quote_ref");

  const values = {
    client_id: typeof clientId === "string" ? clientId : "",
    name: typeof name === "string" ? name : "",
    price: typeof price === "string" ? price : "",
    expected_cost: typeof expectedCost === "string" ? expectedCost : "",
    currency: typeof currency === "string" ? currency : "",
    periodicity: typeof periodicity === "string" ? periodicity : "monthly",
    start_date: typeof startDate === "string" ? startDate : "",
    end_date: typeof endDate === "string" ? endDate : "",
    business_area_id: typeof businessAreaId === "string" ? businessAreaId : "",
    service_type: typeof serviceType === "string" ? serviceType : "",
    invoicing_mode: typeof invoicingMode === "string" ? invoicingMode : "arrears",
    due_day: typeof dueDay === "string" ? dueDay : "",
    due_month: typeof dueMonth === "string" ? dueMonth : "",
    fixed_monthly_cost: typeof fixedMonthlyCost === "string" ? fixedMonthlyCost : "",
    uses_cost_pool: usesCostPool,
    quote_ref: typeof quoteRef === "string" ? quoteRef : "",
  };

  if (typeof clientId !== "string" || !clientId) {
    return { error: "Please select a client.", values };
  }

  if (typeof name !== "string" || !name.trim()) {
    return { error: "Service name is required.", values };
  }

  const parsedPrice = typeof price === "string" ? Number(price) : NaN;

  if (typeof price !== "string" || !price.trim() || !Number.isFinite(parsedPrice)) {
    return { error: "Price must be a number.", values };
  }

  const parsedExpectedCost =
    typeof expectedCost === "string" && expectedCost.trim()
      ? Number(expectedCost)
      : 0;

  if (!Number.isFinite(parsedExpectedCost)) {
    return { error: "Expected cost must be a number.", values };
  }

  if (typeof currency !== "string" || !CURRENCIES.includes(currency)) {
    return { error: "Please select a valid currency.", values };
  }

  if (typeof periodicity !== "string" || !PERIODICITIES.includes(periodicity)) {
    return { error: "Please select a valid periodicity.", values };
  }

  if (typeof startDate !== "string" || !startDate.trim()) {
    return { error: "Start date is required.", values };
  }

  const trimmedEndDate =
    typeof endDate === "string" && endDate.trim() ? endDate.trim() : null;

  if (trimmedEndDate && trimmedEndDate < startDate.trim()) {
    return {
      error: "End date must be on or after the start date.",
      values,
    };
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
    return { error: "Please select a valid service type.", values };
  }

  if (typeof invoicingMode !== "string" || !INVOICING_MODES.includes(invoicingMode as (typeof INVOICING_MODES)[number])) {
    return { error: "Please select a valid invoicing mode.", values };
  }

  const parsedDueDay =
    typeof dueDay === "string" && dueDay.trim() ? Number(dueDay) : null;

  if (parsedDueDay !== null && (!Number.isInteger(parsedDueDay) || parsedDueDay < 1 || parsedDueDay > 31)) {
    return { error: "Due day must be between 1 and 31.", values };
  }

  const parsedDueMonth =
    typeof dueMonth === "string" && dueMonth.trim() ? Number(dueMonth) : null;

  if (parsedDueMonth !== null && (!Number.isInteger(parsedDueMonth) || parsedDueMonth < 1 || parsedDueMonth > 12)) {
    return { error: "Due month must be between 1 and 12.", values };
  }

  if (periodicity === "annual" && parsedDueMonth === null) {
    return { error: "Annual services need a due month.", values };
  }

  const parsedFixedMonthlyCost =
    typeof fixedMonthlyCost === "string" && fixedMonthlyCost.trim()
      ? Number(fixedMonthlyCost)
      : null;

  if (parsedFixedMonthlyCost !== null && !Number.isFinite(parsedFixedMonthlyCost)) {
    return { error: "Fixed monthly cost must be a number.", values };
  }

  const trimmedQuoteRef =
    typeof quoteRef === "string" && quoteRef.trim() ? quoteRef.trim() : null;

  const supabase = await createClient();

  // Server-side cross-company validation: the selected client must
  // exist AND belong to this companyId -- never trust the UI only
  // offered valid options. Defense-in-depth alongside the DB-level
  // recurring_services_validate_company_refs trigger, which is the
  // real guarantee; this check just gives a friendlier error message.
  const { data: client, error: clientError } = await supabase
    .from("clients")
    .select("id")
    .eq("id", clientId)
    .eq("company_id", companyId)
    .maybeSingle();

  if (clientError) {
    console.error(clientError);
    return { error: "Something went wrong. Please try again.", values };
  }

  if (!client) {
    return {
      error: "Selected client does not belong to this company.",
      values,
    };
  }

  // Same defense-in-depth pattern for business_area_id, mirroring the
  // DB-level recurring_services_validate_business_area trigger added
  // in 20260922010000.
  if (trimmedBusinessAreaId) {
    const { data: area, error: areaError } = await supabase
      .from("business_areas")
      .select("id")
      .eq("id", trimmedBusinessAreaId)
      .eq("company_id", companyId)
      .maybeSingle();

    if (areaError) {
      console.error(areaError);
      return { error: "Something went wrong. Please try again.", values };
    }

    if (!area) {
      return {
        error: "Selected business area does not belong to this company.",
        values,
      };
    }
  }

  try {
    const { error } = await supabase.from("recurring_services").insert({
      company_id: companyId,
      client_id: clientId,
      name: name.trim(),
      price: parsedPrice,
      expected_cost: parsedExpectedCost,
      currency,
      periodicity,
      start_date: startDate.trim(),
      end_date: trimmedEndDate,
      business_area_id: trimmedBusinessAreaId,
      service_type: trimmedServiceType,
      invoicing_mode: invoicingMode,
      due_day: parsedDueDay,
      due_month: parsedDueMonth,
      fixed_monthly_cost: parsedFixedMonthlyCost,
      uses_cost_pool: usesCostPool,
      quote_ref: trimmedQuoteRef,
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

  redirect(`/companies/${companyId}/recurring-services`);
}
