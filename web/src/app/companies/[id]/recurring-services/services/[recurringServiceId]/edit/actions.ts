"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { checkSupplier, suggestCostsForService, syncRecurringServiceCycles } from "@/lib/recurringServiceCycles";
import {
  SERVICE_TYPES,
  INVOICING_MODES,
  RECURRING_SERVICE_STATUSES,
  parseCostFields,
  parsePricing,
  resolveServiceCurrency,
  serviceCountry,
  type ServiceType,
  type RecurringServiceStatus,
} from "@/lib/recurringServiceTypes";

export type EditRecurringServiceState = {
  error: string | null;
};

const PERIODICITIES = ["monthly", "annual"];

export async function updateRecurringService(
  companyId: string,
  recurringServiceId: string,
  _prevState: EditRecurringServiceState,
  formData: FormData,
): Promise<EditRecurringServiceState> {
  const clientId = formData.get("client_id");
  const name = formData.get("name");
  const currency = formData.get("currency");
  const periodicity = formData.get("periodicity");
  const startDate = formData.get("start_date");
  const endDate = formData.get("end_date");
  const status = formData.get("status");
  const businessAreaId = formData.get("business_area_id");
  const serviceType = formData.get("service_type");
  const invoicingMode = formData.get("invoicing_mode");
  const dueDay = formData.get("due_day");
  const usesCostPool = formData.get("uses_cost_pool") === "on";
  const quoteRef = formData.get("quote_ref");
  const requiresInvoice = formData.get("requires_invoice") === "on";
  const notes = formData.get("notes");

  if (typeof clientId !== "string" || !clientId) {
    return { error: "Please select a client." };
  }

  if (typeof name !== "string" || !name.trim()) {
    return { error: "Service name is required." };
  }

  const pricing = parsePricing(formData);

  if (!pricing.ok) {
    return { error: pricing.error };
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

  // An annual service's due month is derived by the database from the
  // start date and the mode (20261020020000): never taken from the form.

  if (trimmedServiceType === "domain" && periodicity !== "annual") {
    return { error: "Un dominio es anual: elegí periodicidad anual." };
  }

  const costs = parseCostFields(formData, { usesCostPool, serviceType: trimmedServiceType });

  if (!costs.ok) {
    return { error: costs.error };
  }

  const trimmedQuoteRef =
    typeof quoteRef === "string" && quoteRef.trim() ? quoteRef.trim() : null;

  const supabase = await createClient();

  // Same country/currency rule as the create action.
  const { data: company, error: companyError } = await supabase
    .from("companies")
    .select("country")
    .eq("id", companyId)
    .maybeSingle();

  if (companyError || !company) {
    if (companyError) console.error(companyError);
    return { error: "Something went wrong. Please try again." };
  }

  const country = serviceCountry(company.country);
  const resolvedCurrency = resolveServiceCurrency(country, currency);

  if (!resolvedCurrency) {
    return {
      error: country === "UY" ? "Elegí la moneda: USD o UYU." : "Please select a valid currency.",
    };
  }

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

  // Same defense-in-depth for the supplier; the one already on the service
  // may stay even if it was deactivated since (the database allows that).
  const { data: previous, error: previousError } = await supabase
    .from("recurring_services")
    .select("start_date, periodicity, invoicing_mode, supplier_id, fixed_cost, cost_periodicity, uses_cost_pool")
    .eq("id", recurringServiceId)
    .eq("company_id", companyId)
    .maybeSingle();

  if (previousError) {
    console.error(previousError);
    return { error: "Something went wrong. Please try again." };
  }

  if (costs.supplier_id && costs.supplier_id !== previous?.supplier_id) {
    const supplierProblem = await checkSupplier(supabase, companyId, costs.supplier_id);
    if (supplierProblem) return { error: supplierProblem };
  }

  // `active` is derived from `status` here (Phase 5 gave `status` its
  // own Activo/Pausado/Cancelado select, replacing Phase 3's "kept in
  // sync with a checkbox" placeholder) -- both paused and cancelled
  // map to active=false, since either one should stop this service
  // from being picked up by the old manual-generate button (list
  // page's canGenerate) the same way it already stops the Phase 4
  // cron (which filters on status='active' directly).
  const nextStatus = status as RecurringServiceStatus;

  let query = "";

  // Relies on RLS (any-member UPDATE policy scoped to company_id) to
  // reject non-members -- no membership check here. A non-member's
  // update matches zero rows rather than erroring.
  try {
    const { data, error } = await supabase
      .from("recurring_services")
      .update({
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
        active: nextStatus === "active",
        status: nextStatus,
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

    // New start date (or, for an annual service, a new anniversary or
    // mode): create the missing cycles from it (never deletes any --
    // moving the start forward leaves earlier cycles in place, and the
    // service's page offers to void them).
    if (
      previous &&
      (previous.start_date !== startDate.trim() ||
        previous.periodicity !== periodicity ||
        previous.invoicing_mode !== invoicingMode)
    ) {
      const sync = await syncRecurringServiceCycles(supabase, companyId, recurringServiceId, company.country);
      query = sync.error
        ? "?sync=error"
        : `?ciclos=${sync.created}&vinculados=${sync.linked}&revisar=${sync.toReview}`;
    } else if (
      previous &&
      (previous.supplier_id !== costs.supplier_id ||
        Number(previous.fixed_cost ?? -1) !== Number(costs.fixed_cost ?? -1) ||
        previous.cost_periodicity !== costs.cost_periodicity ||
        previous.uses_cost_pool !== usesCostPool)
    ) {
      // The database already re-made the cost periods (trigger
      // recurring_services_sync_cost_periods): offer them the supplier's
      // invoices.
      await suggestCostsForService(supabase, companyId, recurringServiceId);
    }
  } catch (error) {
    console.error(error);
    return { error: "Something went wrong. Please try again." };
  }

  redirect(`/companies/${companyId}/recurring-services/services/${recurringServiceId}${query}`);
}
