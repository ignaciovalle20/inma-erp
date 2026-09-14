"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export type ReassignPeriodState = {
  error: string | null;
};

/**
 * Story 6.6: reassigns which month a cost document's expense is
 * recognized in for reporting -- never touches document_date or any
 * financial field, only the three period-recognition columns (see
 * reassign_cost_document_period()). The cost detail page is otherwise
 * deliberately read-only (Story 6.4's boundary); this RPC is a
 * strictly narrower capability than full document editing, so it does
 * not reopen that boundary. The month input submits a "YYYY-MM" value;
 * it's normalized to the first-of-month date the RPC requires.
 */
export async function reassignCostDocumentPeriod(
  companyId: string,
  costDocumentId: string,
  _prevState: ReassignPeriodState,
  formData: FormData,
): Promise<ReassignPeriodState> {
  const month = formData.get("recognized_period");

  if (typeof month !== "string" || !/^\d{4}-\d{2}$/.test(month)) {
    return { error: "Elegí un mes válido." };
  }

  const period = `${month}-01`;

  const supabase = await createClient();

  const { error } = await supabase.rpc("reassign_cost_document_period", {
    p_cost_document_id: costDocumentId,
    p_period: period,
  });

  if (error) {
    console.error(error);
    return { error: "Algo salió mal. Intentá de nuevo." };
  }

  redirect(`/companies/${companyId}/costs/${costDocumentId}`);
}
