"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export type SalesLineInput = {
  description: string;
  amount: string;
};

export type EditSalesDocumentState = {
  error: string | null;
  values: {
    client_id: string;
    document_type: string;
    document_date: string;
    currency: string;
    tax_amount: string;
    lines: SalesLineInput[];
  };
};

const DOCUMENT_TYPES = ["invoice", "receipt", "credit_note", "manual"];

function parseLines(formData: FormData): SalesLineInput[] {
  const descriptions = formData.getAll("line_description");
  const amounts = formData.getAll("line_amount");
  const count = Math.max(descriptions.length, amounts.length);

  const lines: SalesLineInput[] = [];
  for (let i = 0; i < count; i++) {
    const description = descriptions[i];
    const amount = amounts[i];
    lines.push({
      description: typeof description === "string" ? description : "",
      amount: typeof amount === "string" ? amount : "",
    });
  }
  return lines;
}

export async function updateSalesDocument(
  companyId: string,
  salesDocumentId: string,
  _prevState: EditSalesDocumentState,
  formData: FormData,
): Promise<EditSalesDocumentState> {
  const clientId = formData.get("client_id");
  const documentType = formData.get("document_type");
  const documentDate = formData.get("document_date");
  const currency = formData.get("currency");
  const taxAmount = formData.get("tax_amount");
  const lines = parseLines(formData);

  const values = {
    client_id: typeof clientId === "string" ? clientId : "",
    document_type: typeof documentType === "string" ? documentType : "manual",
    document_date: typeof documentDate === "string" ? documentDate : "",
    currency: typeof currency === "string" ? currency : "",
    tax_amount: typeof taxAmount === "string" ? taxAmount : "",
    lines: lines.length > 0 ? lines : [{ description: "", amount: "" }],
  };

  if (typeof clientId !== "string" || !clientId) {
    return { error: "Please select a client.", values };
  }

  if (typeof documentType !== "string" || !DOCUMENT_TYPES.includes(documentType)) {
    return { error: "Please select a valid document type.", values };
  }

  if (typeof documentDate !== "string" || !documentDate.trim()) {
    return { error: "Document date is required.", values };
  }

  if (typeof currency !== "string" || !currency.trim()) {
    return { error: "Currency is required.", values };
  }

  // A document needs at least one line -- block here with a friendly
  // validation error rather than letting an empty submission hit the
  // DB (update_sales_document also rejects it, but that's the backstop
  // against a tampered request, not the expected UX path).
  const validLines = lines.filter(
    (line) => line.amount.trim() !== "" && Number.isFinite(Number(line.amount)),
  );

  if (validLines.length === 0) {
    return {
      error: "Add at least one line with a valid amount.",
      values,
    };
  }

  const parsedTax =
    typeof taxAmount === "string" && taxAmount.trim() ? Number(taxAmount) : 0;

  if (!Number.isFinite(parsedTax) || parsedTax < 0) {
    return { error: "Tax amount must be a non-negative number.", values };
  }

  const supabase = await createClient();

  // App-level guard against editing a voided document -- the RPC also
  // refuses it (the real guarantee against a tampered request), but
  // checking first avoids a confusing raw DB error for the normal UX
  // path and satisfies "the app refuses before any write".
  const { data: existing, error: existingError } = await supabase
    .from("sales_documents")
    .select("voided")
    .eq("id", salesDocumentId)
    .eq("company_id", companyId)
    .maybeSingle();

  if (existingError) {
    console.error(existingError);
    return { error: "Something went wrong. Please try again.", values };
  }

  if (!existing) {
    return { error: "You don't have permission to edit this document.", values };
  }

  if (existing.voided) {
    return { error: "This document was voided and can no longer be edited.", values };
  }

  const rpcLines = validLines.map((line) => ({
    description: line.description.trim() || null,
    amount: Number(line.amount),
  }));

  const { error } = await supabase.rpc("update_sales_document", {
    p_sales_document_id: salesDocumentId,
    p_client_id: clientId,
    p_document_type: documentType,
    p_document_date: documentDate.trim(),
    p_currency: currency.trim(),
    p_tax_amount: parsedTax,
    p_lines: rpcLines,
  });

  if (error) {
    console.error(error);
    return {
      error: "Something went wrong. Please try again.",
      values,
    };
  }

  redirect(`/companies/${companyId}/sales`);
}

export type VoidSalesDocumentState = {
  error: string | null;
};

export async function voidSalesDocument(
  companyId: string,
  salesDocumentId: string,
  _prevState: VoidSalesDocumentState,
  _formData: FormData,
): Promise<VoidSalesDocumentState> {
  const supabase = await createClient();

  const { error } = await supabase.rpc("void_sales_document", {
    p_sales_document_id: salesDocumentId,
  });

  if (error) {
    console.error(error);
    return { error: "Something went wrong. Please try again." };
  }

  redirect(`/companies/${companyId}/sales`);
}
