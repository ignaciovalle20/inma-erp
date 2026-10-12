import "server-only";

import { createClient } from "@/lib/supabase/server";
import { PROJECT_STATUSES } from "@/lib/projectStatus";
import type { ProjectStatus } from "@/lib/dal";
import type { Draft, ExpenseDraft, SaleDraft, ProjectDraft, ProjectStatusDraft } from "@/lib/ai/tools";

/**
 * Saves a draft the person confirmed, from the in-app chat
 * (api/assistant/confirm) or from an MCP client (confirm_draft). The draft
 * comes back from outside, so it is re-validated here with the same rules
 * as the human forms, and saved through the same RPCs/updates they use --
 * under the caller's own session, so RLS and auth.uid() apply as usual.
 */

export type SaveDraftResult =
  | { ok: true; id: string; href: string }
  | { ok: false; error: string; status: number };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidLines(lines: unknown): lines is { description: string | null; amount: number }[] {
  return (
    Array.isArray(lines) &&
    lines.length > 0 &&
    lines.every(
      (line) =>
        typeof line === "object" &&
        line !== null &&
        Number.isFinite((line as { amount: unknown }).amount) &&
        (line as { amount: number }).amount > 0,
    )
  );
}

function isValidDocumentBase(d: Partial<ExpenseDraft | SaleDraft>): boolean {
  return (
    typeof d.document_date === "string" &&
    DATE_RE.test(d.document_date) &&
    typeof d.currency === "string" &&
    !!d.currency &&
    Number.isFinite(d.tax_amount) &&
    (d.tax_amount as number) >= 0 &&
    isValidLines(d.lines)
  );
}

export function isValidExpenseDraft(draft: unknown): draft is ExpenseDraft {
  const d = draft as Partial<ExpenseDraft> | null;
  return (
    !!d &&
    d.kind === "expense" &&
    (d.classification === "direct" || d.classification === "general") &&
    isValidDocumentBase(d) &&
    (d.classification !== "direct" || !!d.project_id) &&
    (d.classification !== "general" || !d.project_id)
  );
}

export function isValidSaleDraft(draft: unknown): draft is SaleDraft {
  const d = draft as Partial<SaleDraft> | null;
  return (
    !!d &&
    d.kind === "sale" &&
    typeof d.client_id === "string" &&
    !!d.client_id &&
    ["invoice", "receipt", "credit_note", "manual"].includes(d.document_type as string) &&
    isValidDocumentBase(d)
  );
}

function optionalNonNegative(value: unknown): boolean {
  return value === null || value === undefined || (Number.isFinite(value) && (value as number) >= 0);
}

export function isValidProjectDraft(draft: unknown): draft is ProjectDraft {
  const d = draft as Partial<ProjectDraft> | null;
  return (
    !!d &&
    d.kind === "project" &&
    typeof d.name === "string" &&
    !!d.name.trim() &&
    typeof d.client_id === "string" &&
    !!d.client_id &&
    typeof d.business_area_id === "string" &&
    !!d.business_area_id &&
    PROJECT_STATUSES.includes(d.status as ProjectStatus) &&
    (d.status === "por_cotizar" || (typeof d.quote_number === "string" && !!d.quote_number.trim())) &&
    optionalNonNegative(d.quoted_amount) &&
    optionalNonNegative(d.cost_budget) &&
    (!d.start_date || DATE_RE.test(d.start_date)) &&
    (!d.end_date || DATE_RE.test(d.end_date)) &&
    (!d.start_date || !d.end_date || d.end_date >= d.start_date)
  );
}

export function isValidProjectStatusDraft(draft: unknown): draft is ProjectStatusDraft {
  const d = draft as Partial<ProjectStatusDraft> | null;
  return (
    !!d &&
    d.kind === "project_status" &&
    typeof d.project_id === "string" &&
    !!d.project_id &&
    PROJECT_STATUSES.includes(d.status as ProjectStatus) &&
    (d.status !== "en_espera" || (typeof d.hold_reason === "string" && !!d.hold_reason.trim()))
  );
}

const invalid: SaveDraftResult = { ok: false, error: "invalid_draft", status: 400 };

export async function saveDraft(companyId: string, draft: Draft | undefined | null): Promise<SaveDraftResult> {
  const supabase = await createClient();

  if (draft?.kind === "expense") {
    if (!isValidExpenseDraft(draft)) return invalid;
    const { data, error } = await supabase
      .rpc("create_cost_document", {
        p_company_id: companyId,
        p_supplier_id: draft.supplier_id,
        p_project_id: draft.project_id,
        p_classification: draft.classification,
        p_document_date: draft.document_date,
        p_currency: draft.currency,
        p_tax_amount: draft.tax_amount,
        p_lines: draft.lines.map((l) => ({ description: l.description, amount: l.amount })),
      })
      .select("id")
      .single<{ id: string }>();
    if (error || !data) {
      console.error(error);
      return { ok: false, error: "create_failed", status: 500 };
    }
    // A general cost isn't attributed to any job until it is split --
    // same next step as the human cost form.
    const href =
      draft.classification === "general"
        ? `/companies/${companyId}/costs/${data.id}/allocate`
        : `/companies/${companyId}/costs`;
    return { ok: true, id: data.id, href };
  }

  if (draft?.kind === "sale") {
    if (!isValidSaleDraft(draft)) return invalid;
    const { data, error } = await supabase
      .rpc("create_sales_document", {
        p_company_id: companyId,
        p_client_id: draft.client_id,
        p_document_type: draft.document_type,
        p_document_date: draft.document_date,
        p_currency: draft.currency,
        p_tax_amount: draft.tax_amount,
        p_lines: draft.lines.map((l) => ({ description: l.description, amount: l.amount })),
        p_project_id: draft.project_id,
      })
      .select("id")
      .single<{ id: string }>();
    if (error || !data) {
      console.error(error);
      return { ok: false, error: "create_failed", status: 500 };
    }
    return { ok: true, id: data.id, href: `/companies/${companyId}/sales` };
  }

  if (draft?.kind === "project") {
    if (!isValidProjectDraft(draft)) return invalid;
    // Same cross-company check as the human form: the ids came back from
    // the client, never trust them.
    const [{ data: client }, { data: area }] = await Promise.all([
      supabase.from("clients").select("id").eq("id", draft.client_id).eq("company_id", companyId).maybeSingle(),
      supabase.from("business_areas").select("id").eq("id", draft.business_area_id).eq("company_id", companyId).maybeSingle(),
    ]);
    if (!client || !area) return invalid;

    const { data, error } = await supabase
      .rpc("create_project_with_quote", {
        p_company_id: companyId,
        p_client_id: draft.client_id,
        p_business_area_id: draft.business_area_id,
        p_name: draft.name.trim(),
        p_status: draft.status,
        p_quote_number: draft.quote_number?.trim() || null,
        p_start_date: draft.start_date || null,
        p_end_date: draft.end_date || null,
        p_quoted_amount: draft.quoted_amount ?? null,
        p_cost_budget: draft.cost_budget ?? null,
        p_responsible: draft.responsible?.trim() || null,
        p_invoiceable: draft.invoiceable !== false,
      })
      .select("id")
      .single<{ id: string }>();
    if (error || !data) {
      console.error(error);
      return { ok: false, error: "create_failed", status: 500 };
    }
    return { ok: true, id: data.id, href: `/companies/${companyId}/projects/${data.id}` };
  }

  if (draft?.kind === "project_status") {
    if (!isValidProjectStatusDraft(draft)) return invalid;
    const { data, error } = await supabase
      .from("projects")
      .update({
        status: draft.status,
        hold_reason: draft.status === "en_espera" ? draft.hold_reason?.trim() : null,
      })
      .eq("id", draft.project_id)
      .eq("company_id", companyId)
      .select("id");
    if (error) {
      console.error(error);
      return { ok: false, error: "create_failed", status: 500 };
    }
    if (!data || data.length === 0) {
      return { ok: false, error: "not_found", status: 404 };
    }
    return { ok: true, id: draft.project_id, href: `/companies/${companyId}/projects/board` };
  }

  return invalid;
}
