"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCompanyForEdit } from "@/lib/dal";
import { companyConfig } from "@/lib/companyConfig";
import {
  defaultVatRate,
  describeTechnicianError,
  isBacking,
  isEntryModeOf,
  parsePositiveAmount,
  parseWholePesos,
  type Backing,
  type EnteredAs,
} from "@/lib/technicians";

/**
 * Charges of external technicians (docs/plan-sistema-v3.md, F1). Every write
 * goes through an RPC, which is also what creates or corrects the job's cost
 * (a charge IS a direct cost of its job). Every failure comes back as text for
 * the screen: nothing is left only in the server log.
 *
 * Chile records the backing of each charge (factura, boleta de honorarios or
 * sin respaldo) and how its amount was typed; the database computes the cost
 * of the job and what is paid (create_backed_technician_charge /
 * update_backed_technician_charge, 20261026010000). Uruguay keeps the amount +
 * "IVA incluido" form.
 */

export type ChargeFormState = {
  error: string | null;
  values: {
    personnel_id: string;
    charge_date: string;
    description: string;
    amount: string;
    vat_included: boolean;
    /** Chile only. */
    backing: Backing | "";
    entered_as: EnteredAs | "";
  };
};

export type ChargeActionState = { error: string | null };

function refresh(companyId: string, projectId: string) {
  revalidatePath(`/companies/${companyId}/projects/${projectId}`);
  revalidatePath(`/companies/${companyId}/projects/board`);
  revalidatePath(`/companies/${companyId}/personnel`);
  revalidatePath(`/companies/${companyId}/costs`);
}

function readChargeForm(formData: FormData): ChargeFormState["values"] {
  const text = (name: string) => {
    const value = formData.get(name);
    return typeof value === "string" ? value : "";
  };

  const backing = text("backing");
  const enteredAs = text("entered_as");
  const readBacking: Backing | "" = isBacking(backing) ? backing : "";
  return {
    personnel_id: text("personnel_id"),
    charge_date: text("charge_date"),
    description: text("description"),
    amount: text("amount"),
    vat_included: formData.get("vat_included") === "on",
    backing: readBacking,
    entered_as: readBacking && isEntryModeOf(readBacking, enteredAs) ? enteredAs : "",
  };
}

/** Where to go after saving: a page of this company the form came from, else the job. */
function returnPath(formData: FormData, companyId: string, projectId: string): string {
  const raw = formData.get("return_to");
  const fallback = `/companies/${companyId}/projects/${projectId}`;
  if (typeof raw !== "string" || !raw.startsWith(`/companies/${companyId}/`) || raw.includes("//")) return fallback;
  return raw;
}

/** The amount read with the local convention ("25.000" is 25000), or the message to show. */
function validate(
  values: ChargeFormState["values"],
  needsTechnician: boolean,
  backed: boolean,
): { error: string } | { error: null; amount: number } {
  if (needsTechnician && !values.personnel_id) return { error: "Elegí el técnico." };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(values.charge_date)) return { error: "La fecha es obligatoria." };
  if (backed && !values.backing) return { error: "Elegí el respaldo del cargo." };
  if (backed && !values.entered_as) return { error: "Elegí cómo ingresás el monto." };

  const amount = backed ? parseWholePesos(values.amount) : parsePositiveAmount(values.amount);
  if (amount.kind === "empty") return { error: "El monto debe ser mayor a cero." };
  if (amount.kind === "invalid") return { error: `Monto inválido ${amount.reason}` };
  return { error: null, amount: amount.value };
}

export async function createTechnicianCharge(
  companyId: string,
  projectId: string,
  _prevState: ChargeFormState,
  formData: FormData,
): Promise<ChargeFormState> {
  const values = readChargeForm(formData);

  try {
    const membership = await getCompanyForEdit(companyId);
    if (!membership) return { error: "No tenés acceso a esta empresa.", values };
    const backed = companyConfig(membership.company).country === "CL";

    const checked = validate(values, true, backed);
    if (checked.error !== null) return { error: checked.error, values };

    const supabase = await createClient();
    const { error } = backed
      ? await supabase.rpc("create_backed_technician_charge", {
          p_project_id: projectId,
          p_personnel_id: values.personnel_id,
          p_description: values.description.trim() || null,
          p_charge_date: values.charge_date,
          p_backing: values.backing,
          p_entered_as: values.entered_as,
          p_value: checked.amount,
        })
      : await supabase.rpc("create_technician_charge", {
          p_project_id: projectId,
          p_personnel_id: values.personnel_id,
          p_description: values.description.trim() || null,
          p_charge_date: values.charge_date,
          p_amount: checked.amount,
          p_vat_included: values.vat_included,
          p_vat_rate: defaultVatRate(membership.company),
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
  const destination = returnPath(formData, companyId, projectId);

  try {
    const supabase = await createClient();

    // The rate is the one the charge was loaded with, not today's: a later
    // rate change must never rewrite an old charge. The backing says which
    // form (and RPC) it belongs to.
    const { data: charge, error: readError } = await supabase
      .from("technician_charges")
      .select("vat_rate, backing")
      .eq("id", chargeId)
      .eq("company_id", companyId)
      .maybeSingle();

    if (readError) {
      console.error(readError);
      return { error: describeTechnicianError(readError.message), values };
    }
    if (!charge) return { error: "No se encontró el cargo.", values };
    const backed = Boolean(charge.backing);

    const checked = validate(values, false, backed);
    if (checked.error !== null) return { error: checked.error, values };

    const { error } = backed
      ? await supabase.rpc("update_backed_technician_charge", {
          p_charge_id: chargeId,
          p_description: values.description.trim() || null,
          p_charge_date: values.charge_date,
          p_backing: values.backing,
          p_entered_as: values.entered_as,
          p_value: checked.amount,
        })
      : await supabase.rpc("update_technician_charge", {
          p_charge_id: chargeId,
          p_description: values.description.trim() || null,
          p_charge_date: values.charge_date,
          p_amount: checked.amount,
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
  redirect(destination);
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
