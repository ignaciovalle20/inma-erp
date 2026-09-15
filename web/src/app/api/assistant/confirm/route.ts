import { NextResponse } from "next/server";
import { getSession, getCompanyForEdit } from "@/lib/dal";
import { createClient } from "@/lib/supabase/server";
import type { Draft, ExpenseDraft, SaleDraft } from "@/lib/ai/tools";

type ConfirmRequestBody = {
  companyId?: string;
  draft?: Draft;
};

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

function isValidExpenseDraft(draft: unknown): draft is ExpenseDraft {
  const d = draft as Partial<ExpenseDraft> | null;
  return (
    !!d &&
    d.kind === "expense" &&
    (d.classification === "direct" || d.classification === "general") &&
    typeof d.document_date === "string" &&
    !!d.document_date &&
    typeof d.currency === "string" &&
    !!d.currency &&
    Number.isFinite(d.tax_amount) &&
    (d.tax_amount as number) >= 0 &&
    isValidLines(d.lines) &&
    (d.classification !== "direct" || !!d.project_id)
  );
}

function isValidSaleDraft(draft: unknown): draft is SaleDraft {
  const d = draft as Partial<SaleDraft> | null;
  return (
    !!d &&
    d.kind === "sale" &&
    typeof d.client_id === "string" &&
    !!d.client_id &&
    ["invoice", "receipt", "credit_note", "manual"].includes(d.document_type as string) &&
    typeof d.document_date === "string" &&
    !!d.document_date &&
    typeof d.currency === "string" &&
    !!d.currency &&
    Number.isFinite(d.tax_amount) &&
    (d.tax_amount as number) >= 0 &&
    isValidLines(d.lines)
  );
}

export async function POST(request: Request) {
  const user = await getSession();
  if (!user) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  let body: ConfirmRequestBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  if (!body.companyId) {
    return NextResponse.json({ error: "missing_company" }, { status: 400 });
  }

  const membership = await getCompanyForEdit(body.companyId);
  if (!membership) {
    return NextResponse.json({ error: "company_not_found" }, { status: 404 });
  }

  const draft = body.draft;
  const supabase = await createClient();

  if (draft?.kind === "expense") {
    if (!isValidExpenseDraft(draft)) {
      return NextResponse.json({ error: "invalid_draft" }, { status: 400 });
    }

    const { data, error } = await supabase.rpc("create_cost_document", {
      p_company_id: body.companyId,
      p_supplier_id: draft.supplier_id,
      p_project_id: draft.project_id,
      p_classification: draft.classification,
      p_document_date: draft.document_date,
      p_currency: draft.currency,
      p_tax_amount: draft.tax_amount,
      p_lines: draft.lines,
    });

    if (error) {
      console.error(error);
      return NextResponse.json({ error: "create_failed" }, { status: 500 });
    }

    return NextResponse.json({
      ok: true,
      id: data.id,
      href: `/companies/${body.companyId}/costs`,
    });
  }

  if (draft?.kind === "sale") {
    if (!isValidSaleDraft(draft)) {
      return NextResponse.json({ error: "invalid_draft" }, { status: 400 });
    }

    const { data, error } = await supabase.rpc("create_sales_document", {
      p_company_id: body.companyId,
      p_client_id: draft.client_id,
      p_document_type: draft.document_type,
      p_document_date: draft.document_date,
      p_currency: draft.currency,
      p_tax_amount: draft.tax_amount,
      p_lines: draft.lines,
      p_project_id: draft.project_id,
    });

    if (error) {
      console.error(error);
      return NextResponse.json({ error: "create_failed" }, { status: 500 });
    }

    return NextResponse.json({
      ok: true,
      id: data.id,
      href: `/companies/${body.companyId}/sales`,
    });
  }

  return NextResponse.json({ error: "invalid_draft" }, { status: 400 });
}
