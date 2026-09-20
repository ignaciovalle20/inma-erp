"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCompanyForEdit } from "@/lib/dal";
import { defaultVatRate, describeTechnicianError } from "@/lib/technicians";

/**
 * Charges of external technicians (docs/plan-sistema-v3.md, F1). Every write
 * goes through an RPC, which is also what creates or corrects the job's cost
 * (a charge IS a direct cost of its job). Every failure comes back as text for
 * the screen: nothing is left only in the server log.
 */

export type ChargeFormState = {
  error: string | null;
  values: {
    personnel_id: string;
    charge_date: string;
    description: string;
    amount: string;
    vat_included: boolean;
  };
};

export type ChargeActionState = { error: string | null };

function refresh(companyId: string, projectId: string) {
  revalidatePath(`/companies/${companyId}/projects/${projectId}`);
  revalidatePath(`/companies/${companyId}/projects/board`);
  revalidatePath(`/companies/${companyId}/personnel`);
  revalidatePath(`/companies/${companyId}/costs`);
}

function readChargeForm(formData: FormData) {
  const text = (name: string) => {
    const value = formData.get(name);
    return typeof value === "string" ? value : "";
  };

  return {
    personnel_id: text("personnel_id"),
    charge_date: text("charge_date"),
    description: text("description"),
    amount: text("amount"),
    vat_included: formData.get("vat_included") === "on",
  };
}

function validate(values: ChargeFormState["values"], needsTechnician: boolean): string | null {
  if (needsTechnician && !values.personnel_id) return "Elegí el técnico.";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(values.charge_date)) return "La fecha es obligatoria.";

  const amount = Number(values.amount);
  if (values.amount.trim() === "" || !Number.isFinite(amount) || amount <= 0) {
    return "El monto debe ser mayor a cero.";
  }
  return null;
}

export async function createTechnicianCharge(
  companyId: string,
  projectId: string,
  _prevState: ChargeFormState,
  formData: FormData,
): Promise<ChargeFormState> {
  const values = readChargeForm(formData);

  const invalid = validate(values, true);
  if (invalid) return { error: invalid, values };

  try {
    const membership = await getCompanyForEdit(companyId);
    if (!membership) return { error: "No tenés acceso a esta empresa.", values };

    const supabase = await createClient();
    const { error } = await supabase.rpc("create_technician_charge", {
      p_project_id: projectId,
      p_personnel_id: values.personnel_id,
      p_description: values.description.trim() || null,
      p_charge_date: values.charge_date,
      p_amount: Number(values.amount),
      p_vat_included: values.vat_included,
      p_vat_rate: defaultVatRate(membership.company.currency),
    });

    if (error) {
      console.error(error);
      return { error: describeTechnicianError(error.message), values };
    }
  } catch (thrown) {
    console.error(thrown);
    return { error: thrown instanceof Error ? thrown.message : "No se pudo registrar el cargo.", values };
  }

  refresh(companyId, projectId);
  redirect(`/companies/${companyId}/projects/${projectId}`);
}

export async function updateTechnicianCharge(
  companyId: string,
  projectId: string,
  chargeId: string,
  _prevState: ChargeFormState,
  formData: FormData,
): Promise<ChargeFormState> {
  const values = readChargeForm(formData);

  const invalid = validate(values, false);
  if (invalid) return { error: invalid, values };

  try {
    const supabase = await createClient();

    // The rate is the one the charge was loaded with, not today's: a later
    // rate change must never rewrite an old charge.
    const { data: charge, error: readError } = await supabase
      .from("technician_charges")
      .select("vat_rate")
      .eq("id", chargeId)
      .eq("company_id", companyId)
      .maybeSingle();

    if (readError) {
      console.error(readError);
      return { error: describeTechnicianError(readError.message), values };
    }
    if (!charge) return { error: "No se encontró el cargo.", values };

    const { error } = await supabase.rpc("update_technician_charge", {
      p_charge_id: chargeId,
      p_description: values.description.trim() || null,
      p_charge_date: values.charge_date,
      p_amount: Number(values.amount),
      p_vat_included: values.vat_included,
      p_vat_rate: charge.vat_rate,
    });

    if (error) {
      console.error(error);
      return { error: describeTechnicianError(error.message), values };
    }
  } catch (thrown) {
    console.error(thrown);
    return { error: thrown instanceof Error ? thrown.message : "No se pudo guardar el cargo.", values };
  }

  refresh(companyId, projectId);
  redirect(`/companies/${companyId}/projects/${projectId}`);
}

export async function deleteTechnicianCharge(
  companyId: string,
  projectId: string,
  chargeId: string,
): Promise<ChargeActionState> {
  try {
    const supabase = await createClient();
    const { error } = await supabase.rpc("delete_technician_charge", { p_charge_id: chargeId });

    if (error) {
      console.error(error);
      return { error: describeTechnicianError(error.message) };
    }
  } catch (thrown) {
    console.error(thrown);
    return { error: thrown instanceof Error ? thrown.message : "No se pudo eliminar el cargo." };
  }

  refresh(companyId, projectId);
  redirect(`/companies/${companyId}/projects/${projectId}`);
}

/**
 * The boleta / factura of a charge arrived (or was marked by mistake). Used
 * through useActionState, which also passes the previous state and the form
 * data: neither is needed.
 */
export async function setTechnicianChargeDocument(
  companyId: string,
  projectId: string,
  chargeId: string,
  status: "pendiente" | "recibida",
): Promise<ChargeActionState> {
  try {
    const supabase = await createClient();
    const { error } = await supabase.rpc("set_technician_charge_document", {
      p_charge_id: chargeId,
      p_document_status: status,
    });

    if (error) {
      console.error(error);
      return { error: describeTechnicianError(error.message) };
    }
  } catch (thrown) {
    console.error(thrown);
    return { error: thrown instanceof Error ? thrown.message : "No se pudo actualizar el documento." };
  }

  refresh(companyId, projectId);
  revalidatePath(`/companies/${companyId}/personnel`, "layout");
  return { error: null };
}
