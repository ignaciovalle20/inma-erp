"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export type AddProjectQuoteState = {
  error: string | null;
};

/**
 * Adds another quote number to an existing job -- a trabajo can carry
 * more than one Nubox quote over its life (docs/cambios-flujo-v2.md
 * 4.1 example: 1674 then 1691). No RPC needed here, unlike job
 * creation: there's nothing else that needs to stay atomic with this
 * single insert. project_quotes' own RLS (company membership) plus the
 * project_quotes_validate_company_refs trigger (migration
 * 20260918010000) are the real guarantees; the unique(company_id,
 * quote_number) constraint is what turns a re-typed/duplicate quote
 * number into a friendly error instead of a silent second row.
 */
export async function addProjectQuote(
  companyId: string,
  projectId: string,
  _prevState: AddProjectQuoteState,
  formData: FormData,
): Promise<AddProjectQuoteState> {
  const quoteNumber = formData.get("quote_number");

  if (typeof quoteNumber !== "string" || !quoteNumber.trim()) {
    return { error: "El N° de cotización es obligatorio." };
  }

  const supabase = await createClient();

  const { error } = await supabase.from("project_quotes").insert({
    project_id: projectId,
    company_id: companyId,
    quote_number: quoteNumber.trim(),
  });

  if (error) {
    console.error(error);
    // 23505 = unique(company_id, quote_number) violation: the raw
    // Postgres text names the constraint, which is noise for the user.
    if (error.code === "23505") {
      return { error: "Ese N° de cotización ya está en uso." };
    }
    return { error: error.message };
  }

  revalidatePath(`/companies/${companyId}/projects/${projectId}`);
  return { error: null };
}
