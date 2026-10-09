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

// ---------------------------------------------------------------------
// Checklist and notes (migration 20261006020000)
// ---------------------------------------------------------------------
// Called from client components as plain functions (inside
// useTransition), like the board's updateProjectStatus: they return the
// real error message instead of throwing, so the UI can show it. RLS
// (company membership; notes: only their author) plus the tables'
// before-write triggers are the real guarantees. An update/delete that RLS
// filters out matches zero rows instead of erroring, hence the
// .select("id") checks.

export type ProjectLogResult = { error: string | null };

const NOT_FOUND = "No se encontró el elemento o no tenés permiso para modificarlo.";

function revalidateProject(companyId: string, projectId: string) {
  revalidatePath(`/companies/${companyId}/projects/${projectId}`);
  // The list shows the checklist progress.
  revalidatePath(`/companies/${companyId}/projects`);
}

export async function addChecklistItem(
  companyId: string,
  projectId: string,
  text: string,
): Promise<ProjectLogResult> {
  const trimmed = text.trim();
  if (!trimmed) {
    return { error: "Escribí el ítem." };
  }

  const supabase = await createClient();

  // New items go last.
  const { data: last, error: lastError } = await supabase
    .from("project_checklist_items")
    .select("position")
    .eq("company_id", companyId)
    .eq("project_id", projectId)
    .order("position", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (lastError) {
    console.error(lastError);
    return { error: lastError.message };
  }

  const { error } = await supabase.from("project_checklist_items").insert({
    company_id: companyId,
    project_id: projectId,
    text: trimmed,
    position: (last?.position ?? -1) + 1,
  });

  if (error) {
    console.error(error);
    return { error: error.message };
  }

  revalidateProject(companyId, projectId);
  return { error: null };
}

export async function updateChecklistItem(
  companyId: string,
  projectId: string,
  itemId: string,
  changes: { text?: string; is_done?: boolean },
): Promise<ProjectLogResult> {
  const update: { text?: string; is_done?: boolean } = {};

  if (typeof changes.text === "string") {
    const trimmed = changes.text.trim();
    if (!trimmed) {
      return { error: "El ítem no puede quedar vacío." };
    }
    update.text = trimmed;
  }
  if (typeof changes.is_done === "boolean") {
    update.is_done = changes.is_done;
  }
  if (Object.keys(update).length === 0) {
    return { error: "No hay cambios para guardar." };
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("project_checklist_items")
    .update(update)
    .eq("id", itemId)
    .eq("company_id", companyId)
    .eq("project_id", projectId)
    .select("id");

  if (error) {
    console.error(error);
    return { error: error.message };
  }
  if (!data || data.length === 0) {
    return { error: NOT_FOUND };
  }

  revalidateProject(companyId, projectId);
  return { error: null };
}

export async function deleteChecklistItem(
  companyId: string,
  projectId: string,
  itemId: string,
): Promise<ProjectLogResult> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("project_checklist_items")
    .delete()
    .eq("id", itemId)
    .eq("company_id", companyId)
    .eq("project_id", projectId)
    .select("id");

  if (error) {
    console.error(error);
    return { error: error.message };
  }
  if (!data || data.length === 0) {
    return { error: NOT_FOUND };
  }

  revalidateProject(companyId, projectId);
  return { error: null };
}

/** Swaps the item with the one above (-1) or below (+1). */
export async function moveChecklistItem(
  companyId: string,
  projectId: string,
  itemId: string,
  direction: -1 | 1,
): Promise<ProjectLogResult> {
  if (direction !== -1 && direction !== 1) {
    return { error: "Dirección inválida." };
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("move_project_checklist_item", {
    p_item_id: itemId,
    p_direction: direction,
  });

  if (error) {
    console.error(error);
    return { error: error.message };
  }

  revalidateProject(companyId, projectId);
  return { error: null };
}

export async function addProjectNote(
  companyId: string,
  projectId: string,
  body: string,
): Promise<ProjectLogResult> {
  if (!body.trim()) {
    return { error: "Escribí la nota." };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { error: "Tu sesión expiró. Volvé a ingresar." };
  }

  const { error } = await supabase.from("project_notes").insert({
    company_id: companyId,
    project_id: projectId,
    kind: "note",
    body: body.trim(),
    author_id: user.id,
  });

  if (error) {
    console.error(error);
    return { error: error.message };
  }

  revalidatePath(`/companies/${companyId}/projects/${projectId}`);
  return { error: null };
}

export async function updateProjectNote(
  companyId: string,
  projectId: string,
  noteId: string,
  body: string,
): Promise<ProjectLogResult> {
  if (!body.trim()) {
    return { error: "La nota no puede quedar vacía." };
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("project_notes")
    .update({ body: body.trim() })
    .eq("id", noteId)
    .eq("company_id", companyId)
    .eq("project_id", projectId)
    .eq("kind", "note")
    .select("id");

  if (error) {
    console.error(error);
    return { error: error.message };
  }
  if (!data || data.length === 0) {
    return { error: NOT_FOUND };
  }

  revalidatePath(`/companies/${companyId}/projects/${projectId}`);
  return { error: null };
}

export async function deleteProjectNote(
  companyId: string,
  projectId: string,
  noteId: string,
): Promise<ProjectLogResult> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("project_notes")
    .delete()
    .eq("id", noteId)
    .eq("company_id", companyId)
    .eq("project_id", projectId)
    .eq("kind", "note")
    .select("id");

  if (error) {
    console.error(error);
    return { error: error.message };
  }
  if (!data || data.length === 0) {
    return { error: NOT_FOUND };
  }

  revalidatePath(`/companies/${companyId}/projects/${projectId}`);
  return { error: null };
}
