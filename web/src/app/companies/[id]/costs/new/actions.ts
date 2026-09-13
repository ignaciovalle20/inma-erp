"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { findPotentialDuplicateCost, type PotentialDuplicateCost } from "@/lib/dal";

export type CostLineInput = {
  description: string;
  amount: string;
};

export type CreateCostDocumentState = {
  error: string | null;
  duplicateWarning: PotentialDuplicateCost | null;
  values: {
    supplier_id: string;
    project_id: string;
    classification: string;
    document_date: string;
    currency: string;
    tax_amount: string;
    lines: CostLineInput[];
  };
};

const CLASSIFICATIONS = ["direct", "general"];

function parseLines(formData: FormData): CostLineInput[] {
  const descriptions = formData.getAll("line_description");
  const amounts = formData.getAll("line_amount");
  const count = Math.max(descriptions.length, amounts.length);

  const lines: CostLineInput[] = [];
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

export async function createCostDocument(
  companyId: string,
  _prevState: CreateCostDocumentState,
  formData: FormData,
): Promise<CreateCostDocumentState> {
  const supplierId = formData.get("supplier_id");
  const projectId = formData.get("project_id");
  const classification = formData.get("classification");
  const documentDate = formData.get("document_date");
  const currency = formData.get("currency");
  const taxAmount = formData.get("tax_amount");
  const lines = parseLines(formData);

  const values = {
    supplier_id: typeof supplierId === "string" ? supplierId : "",
    project_id: typeof projectId === "string" ? projectId : "",
    classification: typeof classification === "string" ? classification : "direct",
    document_date: typeof documentDate === "string" ? documentDate : "",
    currency: typeof currency === "string" ? currency : "",
    tax_amount: typeof taxAmount === "string" ? taxAmount : "",
    lines: lines.length > 0 ? lines : [{ description: "", amount: "" }],
  };

  if (typeof classification !== "string" || !CLASSIFICATIONS.includes(classification)) {
    return { error: "Please select a valid classification.", duplicateWarning: null, values };
  }

  const normalizedProjectId =
    typeof projectId === "string" && projectId.trim() ? projectId.trim() : null;

  if (classification === "direct" && !normalizedProjectId) {
    return { error: "A direct cost needs a project.", duplicateWarning: null, values };
  }

  if (classification === "general" && normalizedProjectId) {
    return { error: "A general cost cannot have a project.", duplicateWarning: null, values };
  }

  if (typeof documentDate !== "string" || !documentDate.trim()) {
    return { error: "Document date is required.", duplicateWarning: null, values };
  }

  if (typeof currency !== "string" || !currency.trim()) {
    return { error: "Currency is required.", duplicateWarning: null, values };
  }

  // A document needs at least one line -- block here with a friendly
  // validation error rather than letting an empty submission hit the
  // DB (create_cost_document also rejects it, but that's the backstop
  // against a tampered request, not the expected UX path).
  const validLines = lines.filter(
    (line) => line.amount.trim() !== "" && Number.isFinite(Number(line.amount)),
  );

  if (validLines.length === 0) {
    return {
      error: "Add at least one line with a valid amount.",
      duplicateWarning: null,
      values,
    };
  }

  const parsedTax =
    typeof taxAmount === "string" && taxAmount.trim() ? Number(taxAmount) : 0;

  if (!Number.isFinite(parsedTax) || parsedTax < 0) {
    return { error: "Tax amount must be a non-negative number.", duplicateWarning: null, values };
  }

  const normalizedSupplierId =
    typeof supplierId === "string" && supplierId.trim() ? supplierId.trim() : null;

  const netAmount = validLines.reduce((sum, line) => sum + Number(line.amount), 0);
  const totalAmount = netAmount + parsedTax;

  // Story 3.4: warn (don't block) on a likely duplicate -- same
  // supplier/date/total amount as an existing cost document. Skipped
  // when there's no supplier, per spec. The user must explicitly
  // re-submit with confirm_duplicate=true to proceed.
  const confirmDuplicate = formData.get("confirm_duplicate") === "true";

  if (!confirmDuplicate) {
    const duplicate = await findPotentialDuplicateCost(
      companyId,
      normalizedSupplierId,
      documentDate.trim(),
      totalAmount,
    );

    if (duplicate) {
      return { error: null, duplicateWarning: duplicate, values };
    }
  }

  const supabase = await createClient();

  const rpcLines = validLines.map((line) => ({
    description: line.description.trim() || null,
    amount: Number(line.amount),
  }));

  const { error } = await supabase.rpc("create_cost_document", {
    p_company_id: companyId,
    p_supplier_id: normalizedSupplierId,
    p_project_id: normalizedProjectId,
    p_classification: classification,
    p_document_date: documentDate.trim(),
    p_currency: currency.trim(),
    p_tax_amount: parsedTax,
    p_lines: rpcLines,
  });

  if (error) {
    console.error(error);
    return {
      error: "Something went wrong. Please try again.",
      duplicateWarning: null,
      values,
    };
  }

  redirect(`/companies/${companyId}/costs`);
}
