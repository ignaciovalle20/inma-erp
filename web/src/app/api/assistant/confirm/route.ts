import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { getSession, getCompanyForEdit } from "@/lib/dal";
import { saveDraft } from "@/lib/ai/saveDraft";
import type { Draft } from "@/lib/ai/tools";

type ConfirmRequestBody = {
  companyId?: string;
  draft?: Draft;
};

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

  const saved = await saveDraft(body.companyId, body.draft);
  if (!saved.ok) {
    return NextResponse.json({ error: saved.error }, { status: saved.status });
  }

  // Refresh whatever screen the person is on (board, lists, dashboard).
  revalidatePath(`/companies/${body.companyId}`, "layout");

  return NextResponse.json({ ok: true, id: saved.id, href: saved.href });
}
