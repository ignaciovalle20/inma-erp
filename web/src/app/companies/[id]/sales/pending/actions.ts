"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCompanyForEdit } from "@/lib/dal";

/**
 * Resolutions for the lists on the pendientes screen. Each returns the
 * real failure message (never fails silently) so the row can show it. The
 * RPCs (migration 20260920010000) run with the caller's own rights, so
 * RLS keeps every change inside the caller's companies; the membership
 * check here just gives a clear message first.
 */
export type PendingActionResult = { error: string | null };

async function guard(companyId: string): Promise<PendingActionResult | null> {
  const membership = await getCompanyForEdit(companyId);
  return membership ? null : { error: "No tenés acceso a esta empresa." };
}

function refresh(companyId: string) {
  revalidatePath(`/companies/${companyId}/sales/pending`);
  revalidatePath(`/companies/${companyId}/sales`);
}

export async function pairCreditNoteAction(
  companyId: string,
  creditNoteId: string,
  invoiceId: string,
): Promise<PendingActionResult> {
  try {
    const denied = await guard(companyId);
    if (denied) return denied;

    if (!creditNoteId || !invoiceId) {
      return { error: "Elegí la factura que anula la nota de crédito." };
    }

    const supabase = await createClient();
    const { error } = await supabase.rpc("pair_credit_note", {
      p_credit_note_id: creditNoteId,
      p_invoice_id: invoiceId,
    });

    if (error) {
      console.error(error);
      return { error: error.message };
    }

    refresh(companyId);
    return { error: null };
  } catch (thrown) {
    console.error(thrown);
    return { error: thrown instanceof Error ? thrown.message : "No se pudo emparejar." };
  }
}

export async function linkInvoiceAction(
  companyId: string,
  salesDocumentId: string,
  projectId: string,
): Promise<PendingActionResult> {
  try {
    const denied = await guard(companyId);
    if (denied) return denied;

    if (!projectId) {
      return { error: "Elegí el trabajo al que corresponde la factura." };
    }

    const supabase = await createClient();
    const { error } = await supabase.rpc("link_sales_document_to_project", {
      p_sales_document_id: salesDocumentId,
      p_project_id: projectId,
    });

    if (error) {
      console.error(error);
      return { error: error.message };
    }

    refresh(companyId);
    revalidatePath(`/companies/${companyId}/projects/${projectId}`);
    return { error: null };
  } catch (thrown) {
    console.error(thrown);
    return { error: thrown instanceof Error ? thrown.message : "No se pudo vincular." };
  }
}

export async function markPaidAction(
  companyId: string,
  salesDocumentId: string,
  paidAt: string,
  paymentMethod: string,
): Promise<PendingActionResult> {
  try {
    const denied = await guard(companyId);
    if (denied) return denied;

    if (!/^\d{4}-\d{2}-\d{2}$/.test(paidAt)) {
      return { error: "Indicá la fecha de pago." };
    }

    const supabase = await createClient();
    const { error } = await supabase.rpc("mark_sales_document_paid", {
      p_sales_document_id: salesDocumentId,
      p_paid_at: paidAt,
      p_payment_method: paymentMethod,
    });

    if (error) {
      console.error(error);
      return { error: error.message };
    }

    refresh(companyId);
    return { error: null };
  } catch (thrown) {
    console.error(thrown);
    return { error: thrown instanceof Error ? thrown.message : "No se pudo marcar como pagada." };
  }
}
