"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { SERVICE_TYPES, type ServiceType } from "@/lib/recurringServiceTypes";

export type CreateCostPoolState = {
  error: string | null;
  values: {
    service_type: string;
    period: string;
    total_expense_amount: string;
    currency: string;
    supplier_id: string;
  };
};

const CURRENCIES = ["CLP", "UYU", "USD"];

export async function createCostPool(
  companyId: string,
  _prevState: CreateCostPoolState,
  formData: FormData,
): Promise<CreateCostPoolState> {
  const serviceType = formData.get("service_type");
  const period = formData.get("period");
  const totalExpenseAmount = formData.get("total_expense_amount");
  const currency = formData.get("currency");
  const supplierId = formData.get("supplier_id");

  const values = {
    service_type: typeof serviceType === "string" ? serviceType : "",
    period: typeof period === "string" ? period : "",
    total_expense_amount:
      typeof totalExpenseAmount === "string" ? totalExpenseAmount : "",
    currency: typeof currency === "string" ? currency : "",
    supplier_id: typeof supplierId === "string" ? supplierId : "",
  };

  if (typeof serviceType !== "string" || !SERVICE_TYPES.includes(serviceType as ServiceType)) {
    return { error: "Please select a valid service type.", values };
  }

  // <input type="month"> gives "YYYY-MM" -- normalized to the first of
  // that month, matching how every period is stored throughout this
  // module (recurring_service_occurrences.period,
  // sales_documents.recurring_period).
  if (typeof period !== "string" || !/^\d{4}-\d{2}$/.test(period)) {
    return { error: "Please select a period.", values };
  }
  const periodDate = `${period}-01`;

  const parsedAmount =
    typeof totalExpenseAmount === "string" ? Number(totalExpenseAmount) : NaN;

  if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
    return { error: "Total expense amount must be a positive number.", values };
  }

  if (typeof currency !== "string" || !CURRENCIES.includes(currency)) {
    return { error: "Please select a valid currency.", values };
  }

  const trimmedSupplierId =
    typeof supplierId === "string" && supplierId.trim() ? supplierId.trim() : null;

  const supabase = await createClient();

  // Server-side cross-company validation, same reasoning as every
  // other FK picked from a dropdown in this module.
  if (trimmedSupplierId) {
    const { data: supplier, error: supplierError } = await supabase
      .from("suppliers")
      .select("id")
      .eq("id", trimmedSupplierId)
      .eq("company_id", companyId)
      .maybeSingle();

    if (supplierError) {
      console.error(supplierError);
      return { error: "Something went wrong. Please try again.", values };
    }

    if (!supplier) {
      return { error: "Selected supplier does not belong to this company.", values };
    }
  }

  let newPoolId: string;

  try {
    const { data, error } = await supabase
      .from("recurring_service_cost_pools")
      .insert({
        company_id: companyId,
        service_type: serviceType,
        period: periodDate,
        total_expense_amount: parsedAmount,
        currency,
        supplier_id: trimmedSupplierId,
      })
      .select("id")
      .single();

    if (error) {
      console.error(error);
      // Most likely cause: unique(company_id, service_type, period) --
      // this service type already has a pool for this period.
      return {
        error:
          "Something went wrong. This service type may already have a cost pool for this period.",
        values,
      };
    }

    newPoolId = data.id;
  } catch (error) {
    console.error(error);
    return { error: "Something went wrong. Please try again.", values };
  }

  redirect(`/companies/${companyId}/recurring-services/cost-pools/${newPoolId}`);
}
