"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCompanyForEdit } from "@/lib/dal";
import { getTechnicianAccount } from "@/lib/technicianDal";
import { describeTechnicianError, validatePayment, type Application } from "@/lib/technicians";

/**
 * Payments to an external technician (docs/plan-sistema-v3.md, F1): one payment
 * ("abono") can cover several of their charges. The screen proposes the split
 * (oldest first) and lets it be adjusted; this action checks it against what is
 * really owed and the database checks it again. A failure always comes back as
 * text for the screen.
 */

export type PaymentFormState = {
  error: string | null;
  /** Set when the payment was recorded, so the form can say so and clear itself. */
  saved: boolean;
};

export type PaymentActionState = { error: string | null };

function refresh(companyId: string, personnelId: string) {
  revalidatePath(`/companies/${companyId}/personnel/${personnelId}/account`);
  revalidatePath(`/companies/${companyId}/personnel`);
  revalidatePath(`/companies/${companyId}/projects`, "layout");
}

function parseApplications(raw: string): Application[] | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;

    return parsed.map((entry) => {
      const { chargeId, amount } = entry as { chargeId?: unknown; amount?: unknown };
      if (typeof chargeId !== "string" || typeof amount !== "number") throw new Error("bad entry");
      return { chargeId, amount };
    });
  } catch {
    return null;
  }
}

export async function recordTechnicianPayment(
  companyId: string,
  personnelId: string,
  _prevState: PaymentFormState,
  formData: FormData,
): Promise<PaymentFormState> {
  const text = (name: string) => {
    const value = formData.get(name);
    return typeof value === "string" ? value : "";
  };

  const paymentDate = text("payment_date");
  const amount = Number(text("amount"));
  const applications = parseApplications(text("applications"));

  if (!/^\d{4}-\d{2}-\d{2}$/.test(paymentDate)) {
    return { error: "La fecha del pago es obligatoria.", saved: false };
  }
  if (applications === null) {
    return { error: "No se pudo leer cómo se reparte el pago: recargá la página e intentá de nuevo.", saved: false };
  }

  try {
    const membership = await getCompanyForEdit(companyId);
    if (!membership) return { error: "No tenés acceso a esta empresa.", saved: false };

    // What is really owed, read now: the split the screen proposed may be old.
    const account = await getTechnicianAccount(companyId, personnelId);
    const owed = new Map(account.charges.filter((charge) => charge.outstanding > 0).map((c) => [c.id, c.outstanding]));

    const invalid = validatePayment({ amount, applications, outstandingByCharge: owed });
    if (invalid) return { error: invalid, saved: false };

    const supabase = await createClient();
    const { error } = await supabase.rpc("record_technician_payment", {
      p_personnel_id: personnelId,
      p_payment_date: paymentDate,
      p_amount: amount,
      p_method: text("method").trim() || null,
      p_notes: text("notes").trim() || null,
      p_applications: applications.map((application) => ({
        charge_id: application.chargeId,
        amount: application.amount,
      })),
    });

    if (error) {
      console.error(error);
      return { error: describeTechnicianError(error.message), saved: false };
    }
  } catch (thrown) {
    console.error(thrown);
    return { error: thrown instanceof Error ? thrown.message : "No se pudo registrar el pago.", saved: false };
  }

  refresh(companyId, personnelId);
  return { error: null, saved: true };
}

/** Deleting a payment gives its money back to the charges it covered (their saldo goes up again). */
export async function deleteTechnicianPayment(
  companyId: string,
  personnelId: string,
  paymentId: string,
): Promise<PaymentActionState> {
  try {
    const supabase = await createClient();
    const { error } = await supabase.rpc("delete_technician_payment", { p_payment_id: paymentId });

    if (error) {
      console.error(error);
      return { error: describeTechnicianError(error.message) };
    }
  } catch (thrown) {
    console.error(thrown);
    return { error: thrown instanceof Error ? thrown.message : "No se pudo eliminar el pago." };
  }

  refresh(companyId, personnelId);
  return { error: null };
}
