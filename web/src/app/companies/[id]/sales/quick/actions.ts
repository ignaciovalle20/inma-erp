"use server";

import { createClient } from "@/lib/supabase/server";
import { getCompanyForEdit } from "@/lib/dal";
import { companyConfig, resolveDocumentCurrency } from "@/lib/companyConfig";

export type CreateQuickSalesDocumentState = {
  error: string | null;
  success: boolean;
  values: {
    client_id: string;
    document_date: string;
    amount: string;
    business_area_id: string;
  };
};

export async function createQuickSalesDocument(
  companyId: string,
  _prevState: CreateQuickSalesDocumentState,
  formData: FormData,
): Promise<CreateQuickSalesDocumentState> {
  const clientId = formData.get("client_id");
  const documentDate = formData.get("document_date");
  const amount = formData.get("amount");
  const businessAreaId = formData.get("business_area_id");

  const values = {
    client_id: typeof clientId === "string" ? clientId : "",
    document_date: typeof documentDate === "string" ? documentDate : "",
    amount: typeof amount === "string" ? amount : "",
    business_area_id: typeof businessAreaId === "string" ? businessAreaId : "",
  };

  if (typeof clientId !== "string" || !clientId) {
    return { error: "Please select a client.", success: false, values };
  }

  if (typeof documentDate !== "string" || !documentDate.trim()) {
    return { error: "Date is required.", success: false, values };
  }

  if (typeof businessAreaId !== "string" || !businessAreaId) {
    return { error: "Please select a business area.", success: false, values };
  }

  const parsedAmount = typeof amount === "string" ? Number(amount) : NaN;

  if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
    return {
      error: "Amount must be greater than zero.",
      success: false,
      values,
    };
  }

  // Membership check, and the company's currency rule
  // (lib/companyConfig.ts): fixed for Chile, USD or UYU chosen for Uruguay.
  const membership = await getCompanyForEdit(companyId);

  if (!membership) {
    return {
      error: "No tenés acceso a esta empresa.",
      success: false,
      values,
    };
  }

  const config = companyConfig(membership.company);
  const currency = resolveDocumentCurrency(config, formData.get("currency"));

  if (!currency) {
    return {
      error: `Elegí la moneda: ${config.documentCurrencies.join(" o ")}.`,
      success: false,
      values,
    };
  }

  const supabase = await createClient();

  const { error } = await supabase.rpc("create_sales_document", {
    p_company_id: companyId,
    p_client_id: clientId,
    p_document_type: "manual",
    p_document_date: documentDate.trim(),
    p_currency: currency,
    p_tax_amount: 0,
    p_lines: [{ description: null, amount: parsedAmount }],
    p_business_area_id: businessAreaId,
  });

  if (error) {
    console.error(error);
    return {
      error: "Something went wrong. Please try again.",
      success: false,
      values,
    };
  }

  return {
    error: null,
    success: true,
    values: {
      client_id: "",
      document_date: documentDate.trim(),
      amount: "",
      business_area_id: "",
    },
  };
}
