"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCompanyForEdit } from "@/lib/dal";

/**
 * "Eliminar servicio": delete_recurring_service (20261024010000) removes the
 * service with its cycles and cost periods in one transaction, and refuses
 * while any invoice (sale or purchase) is still assigned to it. Goes back to
 * the services list.
 */
export async function deleteRecurringService(companyId: string, serviceId: string): Promise<{ error: string }> {
  const membership = await getCompanyForEdit(companyId);
  if (!membership) return { error: "No tenés acceso a esta empresa." };

  const supabase = await createClient();
  const { data: service, error: serviceError } = await supabase
    .from("recurring_services")
    .select("id")
    .eq("id", serviceId)
    .eq("company_id", companyId)
    .maybeSingle();
  if (serviceError) {
    console.error(serviceError);
    return { error: "Algo salió mal. Intentá de nuevo." };
  }
  if (!service) return { error: "No se encontró el servicio." };

  const { error } = await supabase.rpc("delete_recurring_service", { p_service_id: serviceId });
  if (error) {
    console.error(error);
    return { error: error.message || "No se pudo eliminar el servicio." };
  }

  revalidatePath(`/companies/${companyId}/recurring-services`, "layout");
  redirect(`/companies/${companyId}/recurring-services/services?eliminado=1`);
}
