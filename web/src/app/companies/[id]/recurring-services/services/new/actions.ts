"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { syncRecurringServiceCycles, type SyncCyclesResult } from "@/lib/recurringServiceCycles";
import {
  SERVICE_TYPES,
  INVOICING_MODES,
  parseCostFields,
  parsePricing,
  resolveServiceCurrency,
  serviceCountry,
  type ServiceType,
} from "@/lib/recurringServiceTypes";
import { checkSupplier } from "@/lib/recurringServiceCycles";

export type CreateRecurringServiceState = {
  error: string | null;
  values: {
    client_id: string;
    name: string;
    pricing_mode: string;
    reference_amount: string;
    unit_price: string;
    default_quantity: string;
    currency: string;
    periodicity: string;
    start_date: string;
    end_date: string;
    business_area_id: string;
    service_type: string;
    invoicing_mode: string;
    due_day: string;
    fixed_cost: string;
    cost_periodicity: string;
    supplier_id: string;
    uses_cost_pool: boolean;
    quote_ref: string;
    requires_invoice: boolean;
    notes: string;
  };
};

const PERIODICITIES = ["monthly", "annual"];

export async function createRecurringService(
  companyId: string,
  _prevState: CreateRecurringServiceState,
  formData: FormData,
): Promise<CreateRecurringServiceState> {
  const clientId = formData.get("client_id");
  const name = formData.get("name");
  const pricingMode = formData.get("pricing_mode");
  const referenceAmount = formData.get("reference_amount");
  const unitPrice = formData.get("unit_price");
  const defaultQuantity = formData.get("default_quantity");
  const currency = formData.get("currency");
  const periodicity = formData.get("periodicity");
  const startDate = formData.get("start_date");
  const endDate = formData.get("end_date");
  const businessAreaId = formData.get("business_area_id");
  const serviceType = formData.get("service_type");
  const invoicingMode = formData.get("invoicing_mode");
  const dueDay = formData.get("due_day");
  const fixedCost = formData.get("fixed_cost");
  const costPeriodicity = formData.get("cost_periodicity");
  const supplierId = formData.get("supplier_id");
  const usesCostPool = formData.get("uses_cost_pool") === "on";
  const quoteRef = formData.get("quote_ref");
  const requiresInvoice = formData.get("requires_invoice") === "on";
  const notes = formData.get("notes");

  const values = {
    client_id: typeof clientId === "string" ? clientId : "",
    name: typeof name === "string" ? name : "",
    pricing_mode: typeof pricingMode === "string" ? pricingMode : "fixed",
    reference_amount: typeof referenceAmount === "string" ? referenceAmount : "",
    unit_price: typeof unitPrice === "string" ? unitPrice : "",
    default_quantity: typeof defaultQuantity === "string" ? defaultQuantity : "",
    currency: typeof currency === "string" ? currency : "",
    periodicity: typeof periodicity === "string" ? periodicity : "monthly",
    start_date: typeof startDate === "string" ? startDate : "",
    end_date: typeof endDate === "string" ? endDate : "",
    business_area_id: typeof businessAreaId === "string" ? businessAreaId : "",
    service_type: typeof serviceType === "string" ? serviceType : "",
    invoicing_mode: typeof invoicingMode === "string" ? invoicingMode : "arrears",
    due_day: typeof dueDay === "string" ? dueDay : "",
    fixed_cost: typeof fixedCost === "string" ? fixedCost : "",
    cost_periodicity: typeof costPeriodicity === "string" ? costPeriodicity : "",
    supplier_id: typeof supplierId === "string" ? supplierId : "",
    uses_cost_pool: usesCostPool,
    quote_ref: typeof quoteRef === "string" ? quoteRef : "",
    requires_invoice: requiresInvoice,
    notes: typeof notes === "string" ? notes : "",
  };

  if (typeof clientId !== "string" || !clientId) {
    return { error: "Please select a client.", values };
  }

  if (typeof name !== "string" || !name.trim()) {
    return { error: "Service name is required.", values };
  }

  const pricing = parsePricing(formData);

  if (!pricing.ok) {
    return { error: pricing.error, values };
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

  // An annual service's due month is derived by the database from the
  // start date and the mode (20261020020000): never taken from the form.

  if (trimmedServiceType === "domain" && periodicity !== "annual") {
    return { error: "Un dominio es anual: elegí periodicidad anual.", values };
  }

  const costs = parseCostFields(formData, { usesCostPool, serviceType: trimmedServiceType });

  if (!costs.ok) {
    return { error: costs.error, values };
  }

  const trimmedQuoteRef =
    typeof quoteRef === "string" && quoteRef.trim() ? quoteRef.trim() : null;

  const supabase = await createClient();

  // Country is never asked: it's the company's (the DB trigger stores it
  // on the service). Chile is always CLP, whatever the form sent;
  // Uruguay must have picked USD or UYU explicitly.
  const { data: company, error: companyError } = await supabase
    .from("companies")
    .select("country")
    .eq("id", companyId)
    .maybeSingle();

  if (companyError || !company) {
    if (companyError) console.error(companyError);
    return { error: "Something went wrong. Please try again.", values };
  }

  const country = serviceCountry(company.country);
  const resolvedCurrency = resolveServiceCurrency(country, currency);

  if (!resolvedCurrency) {
    return {
      error: country === "UY" ? "Elegí la moneda: USD o UYU." : "Please select a valid currency.",
      values,
    };
  }

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

  // Same defense-in-depth for the supplier (recurring_services_validate_supplier):
  // an active supplier of this company.
  if (costs.supplier_id) {
    const supplierProblem = await checkSupplier(supabase, companyId, costs.supplier_id);
    if (supplierProblem) return { error: supplierProblem, values };
  }

  let serviceId: string;
  let sync: SyncCyclesResult;

  try {
    const { data: created, error } = await supabase.from("recurring_services").insert({
      company_id: companyId,
      client_id: clientId,
      name: name.trim(),
      pricing_mode: pricing.pricing_mode,
      reference_amount: pricing.reference_amount,
      unit_price: pricing.unit_price,
      default_quantity: pricing.default_quantity,
      currency: resolvedCurrency,
      periodicity,
      start_date: startDate.trim(),
      end_date: trimmedEndDate,
      business_area_id: trimmedBusinessAreaId,
      service_type: trimmedServiceType,
      invoicing_mode: invoicingMode,
      due_day: parsedDueDay,
      fixed_cost: costs.fixed_cost,
      cost_periodicity: costs.cost_periodicity,
      supplier_id: costs.supplier_id,
      uses_cost_pool: usesCostPool,
      quote_ref: trimmedQuoteRef,
      requires_invoice: requiresInvoice,
      notes: typeof notes === "string" && notes.trim() ? notes.trim() : null,
    }).select("id").single();

    if (error || !created) {
      console.error(error);
      return {
        error: "Something went wrong. Please try again.",
        values,
      };
    }

    serviceId = created.id;
    // A service that started months ago shows up in every month since its
    // start (floor January 2026), with past cycles linked to invoices that
    // are already imported.
    sync = await syncRecurringServiceCycles(supabase, companyId, serviceId, company.country);
  } catch (error) {
    console.error(error);
    return {
      error: "Something went wrong. Please try again.",
      values,
    };
  }

  redirect(`/companies/${companyId}/recurring-services/services/${serviceId}?${syncQuery(sync)}`);
}

/** What the generation did, for the notice on the service's page. */
function syncQuery(sync: SyncCyclesResult): string {
  if (sync.error) return "sync=error";
  return `ciclos=${sync.created}&vinculados=${sync.linked}&revisar=${sync.toReview}`;
}
