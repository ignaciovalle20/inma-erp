"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import {
  describeTechnicianError,
  isEntryModeOf,
  linkErrorCode,
  parseWholePesos,
  type EnteredAs,
  type LinkErrorCode,
} from "@/lib/technicians";
import { suggestTechnicianDocuments } from "@/lib/technicianDocumentSuggestions";

/**
 * Charge <-> purchase document (Chile, 20261026010000): the factura or boleta
 * of a technician backs the charges it covers, each with its amount
 * (apply_technician_document), or stops backing them (unlink_technician_document).
 * Both RPCs do every check and move every peso; these actions only pass what
 * the screen chose and bring back what to say.
 */

export type LinkResult = {
  error: string | null;
  /** Why the database refused, for the screen to react (ALLOCATED asks to confirm). */
  code: LinkErrorCode | null;
  linked: boolean;
};

function refresh(companyId: string, costDocumentId: string) {
  revalidatePath(`/companies/${companyId}/costs`, "layout");
  revalidatePath(`/companies/${companyId}/costs/${costDocumentId}`);
  revalidatePath(`/companies/${companyId}/projects`, "layout");
  revalidatePath(`/companies/${companyId}/personnel`, "layout");
  revalidatePath(`/companies/${companyId}/sales/reconcile`);
}

/** A charge the document covers: the net applied, and how to read its amount if it has no backing yet. */
export type DocumentApplicationItem = {
  charge_id: string;
  amount: number;
  entered_as: EnteredAs | null;
};

export async function applyTechnicianDocument(
  companyId: string,
  costDocumentId: string,
  items: DocumentApplicationItem[],
  replaceAllocations: boolean,
  acceptDifference: boolean,
): Promise<LinkResult> {
  if (items.length === 0) return { error: "Elegí al menos un cargo.", code: "CHARGES", linked: false };

  try {
    const supabase = await createClient();
    const { error } = await supabase.rpc("apply_technician_document", {
      p_cost_document_id: costDocumentId,
      p_items: items,
      p_replace_allocations: replaceAllocations,
      p_accept_difference: acceptDifference,
    });
    if (error) {
      console.error(error);
      return { error: describeTechnicianError(error.message), code: linkErrorCode(error.message), linked: false };
    }
  } catch (thrown) {
    console.error(thrown);
    return {
      error: thrown instanceof Error ? thrown.message : "No se pudo vincular el documento.",
      code: null,
      linked: false,
    };
  }

  refresh(companyId, costDocumentId);
  return { error: null, code: null, linked: true };
}

export async function unlinkTechnicianDocument(
  companyId: string,
  costDocumentId: string,
): Promise<{ error: string | null }> {
  try {
    const supabase = await createClient();
    const { error } = await supabase.rpc("unlink_technician_document", { p_cost_document_id: costDocumentId });
    if (error) {
      console.error(error);
      return { error: describeTechnicianError(error.message) };
    }
  } catch (thrown) {
    console.error(thrown);
    return { error: thrown instanceof Error ? thrown.message : "No se pudo desvincular el documento." };
  }

  refresh(companyId, costDocumentId);
  return { error: null };
}

/**
 * A charge that does not exist yet, created from the document that covers it:
 * same RPC as the job's form, with the document's backing, so the flow does not
 * leave this screen. Returns its id for the screen to select it.
 */
export async function createChargeFromDocument(
  companyId: string,
  costDocumentId: string,
  input: {
    personnelId: string;
    projectId: string;
    chargeDate: string;
    description: string;
    backing: "factura" | "boleta";
    enteredAs: EnteredAs;
    value: string;
  },
): Promise<{ error: string | null; chargeId: string | null }> {
  if (!input.projectId) return { error: "Elegí el proyecto.", chargeId: null };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.chargeDate)) return { error: "La fecha es obligatoria.", chargeId: null };
  if (!isEntryModeOf(input.backing, input.enteredAs)) return { error: "Elegí cómo ingresás el monto.", chargeId: null };
  const amount = parseWholePesos(input.value);
  if (amount.kind === "empty") return { error: "El monto debe ser mayor a cero.", chargeId: null };
  if (amount.kind === "invalid") return { error: `Monto inválido ${amount.reason}`, chargeId: null };

  try {
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("create_backed_technician_charge", {
      p_project_id: input.projectId,
      p_personnel_id: input.personnelId,
      p_description: input.description.trim() || null,
      p_charge_date: input.chargeDate,
      p_backing: input.backing,
      p_entered_as: input.enteredAs,
      p_value: amount.value,
    });
    if (error) {
      console.error(error);
      return { error: describeTechnicianError(error.message), chargeId: null };
    }
    refresh(companyId, costDocumentId);
    return { error: null, chargeId: (data as { id: string }).id };
  } catch (thrown) {
    console.error(thrown);
    return { error: thrown instanceof Error ? thrown.message : "No se pudo crear el cargo.", chargeId: null };
  }
}

/**
 * "¿De qué técnico es?": the document's supplier (its RUT) joins a
 * technician's ficha, so this and every other document of that supplier is
 * recognized as theirs. Then the suggestions of that technician are looked
 * for, like when a RUT is added from the ficha.
 */
export async function assignSupplierToTechnician(
  companyId: string,
  costDocumentId: string,
  supplierId: string,
  personnelId: string,
): Promise<{ error: string | null }> {
  if (!personnelId) return { error: "Elegí el técnico." };

  try {
    const supabase = await createClient();
    const { error } = await supabase
      .from("technician_suppliers")
      .insert({ company_id: companyId, personnel_id: personnelId, supplier_id: supplierId });
    if (error) {
      console.error(error);
      return { error: describeTechnicianError(error.message) };
    }
    const suggestions = await suggestTechnicianDocuments(supabase, companyId, { personnelId });
    if (suggestions.error) console.error(suggestions.error);
  } catch (thrown) {
    console.error(thrown);
    return { error: thrown instanceof Error ? thrown.message : "No se pudo vincular el proveedor al técnico." };
  }

  refresh(companyId, costDocumentId);
  return { error: null };
}
