"use server";

import { createClient } from "@/lib/supabase/server";
import { getCompanyForEdit } from "@/lib/dal";

const CATEGORIES = ["equipment", "materials", "transport", "labor", "other"];

export type CreateQuickCostDocumentState = {
  error: string | null;
  success: boolean;
  values: {
    amount: string;
    category: string;
    description: string;
    document_date: string;
  };
};

export async function createQuickCostDocument(
  companyId: string,
  projectId: string,
  _prevState: CreateQuickCostDocumentState,
  formData: FormData,
): Promise<CreateQuickCostDocumentState> {
  const amount = formData.get("amount");
  const category = formData.get("category");
  const description = formData.get("description");
  const documentDate = formData.get("document_date");

  const values = {
    amount: typeof amount === "string" ? amount : "",
    category: typeof category === "string" ? category : "",
    description: typeof description === "string" ? description : "",
    document_date: typeof documentDate === "string" ? documentDate : "",
  };

  const parsedAmount = typeof amount === "string" ? Number(amount) : NaN;

  if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
    return {
      error: "El monto debe ser mayor a cero.",
      success: false,
      values,
    };
  }

  if (typeof category !== "string" || !CATEGORIES.includes(category)) {
    return { error: "Elegí una categoría.", success: false, values };
  }

  if (typeof documentDate !== "string" || !documentDate.trim()) {
    return { error: "La fecha es obligatoria.", success: false, values };
  }

  // Same membership + currency-gating backstop the quick sales entry
  // Server Action uses -- a direct RPC call from a non-UYU or
  // non-member context should never reach this far.
  const membership = await getCompanyForEdit(companyId);

  if (!membership || membership.company.currency !== "UYU") {
    return {
      error: "La carga rápida no está disponible para esta empresa.",
      success: false,
      values,
    };
  }

  const supabase = await createClient();

  const { data: document, error } = await supabase
    .rpc("create_quick_cost_document", {
      p_company_id: companyId,
      p_project_id: projectId,
      p_amount: parsedAmount,
      p_category: category,
      p_description:
        typeof description === "string" && description.trim()
          ? description.trim()
          : null,
      p_document_date: documentDate.trim(),
      p_currency: membership.company.currency,
    })
    .select()
    .single<{ id: string }>();

  if (error || !document) {
    console.error(error);
    return {
      error: "Algo salió mal. Probá de nuevo.",
      success: false,
      values,
    };
  }

  // Receipt photo is optional -- an empty <input type="file"> submits a
  // zero-byte File named "", not null, so both must be checked. A
  // failed upload doesn't roll back the cost document (it's already
  // saved and usable); it just surfaces as an error so the user can
  // retry attaching the photo from the project's cost list instead of
  // losing the whole entry.
  const receipt = formData.get("receipt");

  if (receipt instanceof File && receipt.size > 0 && receipt.name) {
    const path = `${companyId}/${document.id}/${crypto.randomUUID()}-${receipt.name}`;
    const { error: uploadError } = await supabase.storage
      .from("cost-receipts")
      .upload(path, receipt, { contentType: receipt.type || undefined });

    if (uploadError) {
      console.error(uploadError);
      return {
        error: "El gasto se guardó, pero la foto no se pudo subir. Probá de nuevo desde el detalle del trabajo.",
        success: true,
        values: {
          amount: "",
          category: "",
          description: "",
          document_date: documentDate.trim(),
        },
      };
    }

    const { error: attachmentError } = await supabase
      .from("cost_document_attachments")
      .insert({ cost_document_id: document.id, storage_path: path });

    if (attachmentError) {
      console.error(attachmentError);
    }
  }

  return {
    error: null,
    success: true,
    values: {
      amount: "",
      category: "",
      description: "",
      document_date: documentDate.trim(),
    },
  };
}
