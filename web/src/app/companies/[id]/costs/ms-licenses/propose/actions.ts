"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export type ConfirmProposalState = { error: string | null; needsSecondConfirmation: boolean };

const CODES = /^(NOT_FOUND|NOT_SUPPLIER|EXISTS|ASSIGNED|NOT_POSITIVE|LEGACY|SECOND|NO_CYCLES): ([\s\S]*)$/;

/** The database's code and reason ("SECOND: Intcomex ya tiene..."), else a plain message. */
function reasonOf(message: string): { code: string | null; reason: string } {
  const match = CODES.exec(message);
  return match
    ? { code: match[1], reason: match[2] }
    : { code: null, reason: "No se pudo repartir esta factura." };
}

/**
 * "Es factura de licencias MS -> repartir": creates the pool of ONE invoice
 * and splits its net among the MS clients of its month
 * (create_ms_license_pool_for_invoice, migration 20261109010000), the same
 * split the preview showed. A second licenses invoice of the same supplier and
 * month is only saved with the "también es de licencias" box ticked.
 */
export async function confirmMsLicenseInvoice(
  companyId: string,
  costDocumentId: string,
  _prev: ConfirmProposalState,
  formData: FormData,
): Promise<ConfirmProposalState> {
  const allowSecond = formData.get("allow_second") === "on";

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("create_ms_license_pool_for_invoice", {
    p_cost_document_id: costDocumentId,
    p_allow_second: allowSecond,
  });
  if (error || typeof data !== "string") {
    if (error) console.error(error);
    const { code, reason } = reasonOf(error?.message ?? "");
    return { error: reason, needsSecondConfirmation: code === "SECOND" };
  }

  revalidatePath(`/companies/${companyId}/costs`, "layout");
  redirect(`/companies/${companyId}/costs/ms-licenses/${data}`);
}
