import type { BadgeVariant } from "@/components/Badge";
import type { PaymentStatus } from "@/lib/dal";

/**
 * Single source for how a sale's cobro is labelled and colored, shared by
 * the Nubox preview, the sales list and the pendientes screen.
 * `null` means the sale pre-dates the Nubox import: no data, not "pending".
 */
export const PAYMENT_STATUS_LABEL: Record<PaymentStatus, string> = {
  pagado: "Pagado",
  por_vencer: "Por vencer",
  vencido: "Vencido",
  no_aplica: "No aplica",
  pendiente: "Pendiente",
};

export const PAYMENT_STATUS_VARIANT: Record<PaymentStatus, BadgeVariant> = {
  pagado: "positive",
  por_vencer: "outline",
  vencido: "negative",
  no_aplica: "neutral",
  pendiente: "warning",
};

export const PAYMENT_STATUS_OPTIONS: PaymentStatus[] = [
  "pagado",
  "por_vencer",
  "vencido",
  "pendiente",
  "no_aplica",
];

export function paymentStatusLabel(status: string | null): string {
  if (!status) return "Sin dato";
  return PAYMENT_STATUS_LABEL[status as PaymentStatus] ?? status;
}

export function paymentStatusVariant(status: string | null): BadgeVariant {
  if (!status) return "neutral";
  return PAYMENT_STATUS_VARIANT[status as PaymentStatus] ?? "neutral";
}

/** dd/mm/aaaa from an ISO date, the way Nubox and the Excel show it. */
export function formatDisplayDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const [year, month, day] = iso.split("-");
  return year && month && day ? `${day}/${month}/${year}` : iso;
}

const numberFormat = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 0 });

export function formatAmount(value: number): string {
  return numberFormat.format(value);
}
