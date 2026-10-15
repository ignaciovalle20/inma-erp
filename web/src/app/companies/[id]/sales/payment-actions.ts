"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCompanyForEdit } from "@/lib/dal";
import { PAYMENT_STATUS_LABEL, parsePaymentStatusChange } from "@/lib/paymentStatus";

export type PaymentStatusActionState = { error: string | null; message: string | null };

/**
 * Marks one or many sales Pagada / Impaga: the row action, the bulk bar of
 * the sales list and the detail page all post here. The database
 * (set_sales_documents_payment_status) runs with the caller's own rights,
 * skips voided documents and credit notes, and clears the payment date when
 * a sale goes back to Impaga.
 */
export async function setPaymentStatusAction(
  companyId: string,
  _previous: PaymentStatusActionState,
  formData: FormData,
): Promise<PaymentStatusActionState> {
  try {
    const membership = await getCompanyForEdit(companyId);
    if (!membership) {
      return { error: "No tenés acceso a esta empresa.", message: null };
    }

    const change = parsePaymentStatusChange(formData);
    if (change.error !== null) {
      return { error: change.error, message: null };
    }

    const supabase = await createClient();
    const { data, error } = await supabase.rpc("set_sales_documents_payment_status", {
      p_sales_document_ids: change.ids,
      p_payment_status: change.status,
      p_paid_at: change.paidAt,
    });

    if (error) {
      console.error(error);
      return { error: `No se pudo cambiar el estado de pago: ${error.message}`, message: null };
    }

    revalidatePath(`/companies/${companyId}/sales`);
    revalidatePath(`/companies/${companyId}/sales/pending`);
    for (const id of change.ids) {
      revalidatePath(`/companies/${companyId}/sales/${id}/edit`);
    }

    const count = Number(data ?? 0);
    const label = PAYMENT_STATUS_LABEL[change.status].toLowerCase();
    const skipped = change.ids.length - count;
    return {
      error: null,
      message:
        `${count} venta${count === 1 ? "" : "s"} marcada${count === 1 ? "" : "s"} como ${label}${count === 1 ? "" : "s"}` +
        (skipped > 0 ? ` (${skipped} sin cambiar: anuladas o notas de crédito)` : ""),
    };
  } catch (thrown) {
    console.error(thrown);
    return {
      error: thrown instanceof Error ? thrown.message : "No se pudo cambiar el estado de pago.",
      message: null,
    };
  }
}
