"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getPeriodDetail, getPeriodSummaries } from "@/lib/salesAllocations";
import { currencyDecimals } from "@/lib/currencies";

export type PeriodActionResult = { error: string | null; message?: string };

const GENERIC_ERROR = "Algo salió mal. Probá de nuevo.";

function revalidatePeriods(companyId: string) {
  revalidatePath(`/companies/${companyId}/recurring-services`, "layout");
}

function round(value: number, currency: string): number {
  const factor = 10 ** currencyDecimals(currency);
  return Math.round(value * factor) / factor;
}

/**
 * Units billed this period (per-unit services, e.g. MS licenses). The
 * database recomputes the expected amount (unit price x quantity).
 */
export async function updatePeriodQuantity(
  companyId: string,
  periodId: string,
  value: string,
): Promise<PeriodActionResult> {
  const quantity = Number(value);
  if (!value.trim() || !Number.isFinite(quantity) || quantity < 0) {
    return { error: "La cantidad tiene que ser un número." };
  }

  const detail = await getPeriodDetail(companyId, periodId);
  if (!detail) return { error: "No se encontró este período." };
  if (detail.pricing_mode !== "per_unit") {
    return { error: "Este servicio no se cobra por unidad." };
  }
  if (detail.billing_status === "void") {
    return { error: "Un período anulado no se puede editar." };
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("recurring_service_occurrences")
    .update({ quantity })
    .eq("id", periodId)
    .select("id");

  if (error || !data || data.length === 0) {
    if (error) console.error(error);
    return { error: GENERIC_ERROR };
  }

  revalidatePeriods(companyId);
  return { error: null };
}

/**
 * "Usar este monto como referencial de aquí en adelante": the amount this
 * period was billed for becomes the service's reference (per unit: the
 * unit price, billed / quantity), and the later periods that are still
 * pending with nothing allocated are re-estimated with it. This period and
 * the ones already billed keep their own expected amount.
 */
export async function adoptBilledAmountAsReference(
  companyId: string,
  periodId: string,
): Promise<PeriodActionResult> {
  const detail = await getPeriodDetail(companyId, periodId);
  if (!detail) return { error: "No se encontró este período." };
  if (detail.confirmed_count === 0 || detail.billed_amount <= 0) {
    return { error: "Este período todavía no tiene facturas confirmadas." };
  }

  const supabase = await createClient();
  const perUnit = detail.pricing_mode === "per_unit";
  let unitPrice: number | null = null;

  if (perUnit) {
    const quantity = detail.quantity;
    if (!quantity || quantity <= 0) {
      return { error: "Cargá la cantidad del período para calcular el precio unitario." };
    }
    unitPrice = Math.round((detail.billed_amount / quantity) * 10_000) / 10_000;
  }

  const { data: updated, error: serviceError } = await supabase
    .from("recurring_services")
    .update(perUnit ? { unit_price: unitPrice } : { reference_amount: detail.billed_amount })
    .eq("id", detail.recurring_service_id)
    .eq("company_id", companyId)
    .select("id, default_quantity");

  if (serviceError || !updated || updated.length === 0) {
    if (serviceError) console.error(serviceError);
    return { error: GENERIC_ERROR };
  }

  const later = (await getPeriodSummaries(companyId, { serviceId: detail.recurring_service_id })).filter(
    (period) =>
      period.period > detail.period &&
      period.billing_status === "pending_invoice" &&
      period.confirmed_count === 0 &&
      period.suggested_count === 0,
  );

  const defaultQuantity = Number(updated[0].default_quantity ?? 0);
  let reestimated = 0;
  for (const period of later) {
    const amount = perUnit
      ? round((unitPrice ?? 0) * (period.quantity ?? defaultQuantity), period.currency)
      : detail.billed_amount;
    const { error } = await supabase
      .from("recurring_service_occurrences")
      .update({ amount })
      .eq("id", period.id)
      .eq("status", "pending_invoice");
    if (error) {
      console.error(error);
      return { error: "Se actualizó el referencial, pero no todos los períodos siguientes. Probá de nuevo." };
    }
    reestimated += 1;
  }

  revalidatePeriods(companyId);
  return {
    error: null,
    message:
      reestimated === 0
        ? "Listo: es el nuevo referencial del servicio."
        : `Listo: es el nuevo referencial y se re-estimaron ${reestimated} ${reestimated === 1 ? "período siguiente" : "períodos siguientes"}.`,
  };
}
