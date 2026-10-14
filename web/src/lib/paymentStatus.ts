import type { BadgeVariant } from "@/components/Badge";
import type { PaymentStatus } from "@/lib/dal";

/**
 * Single source for how a sale's payment status is labelled and colored,
 * shared by the import previews, the sales list, its filter and the
 * pendientes screen. Two states only (migration 20261014010000): Pagada or
 * Impaga, Impaga by default. Overdue is not a state: an impaga with a past
 * due date is shown as "vencida" next to the badge.
 */
export const PAYMENT_STATUS_LABEL: Record<PaymentStatus, string> = {
  pagado: "Pagada",
  impago: "Impaga",
};

export const PAYMENT_STATUS_VARIANT: Record<PaymentStatus, BadgeVariant> = {
  pagado: "positive",
  impago: "warning",
};

export const PAYMENT_STATUS_OPTIONS: PaymentStatus[] = ["pagado", "impago"];

export function isPaymentStatus(value: unknown): value is PaymentStatus {
  return value === "pagado" || value === "impago";
}

export function paymentStatusLabel(status: string | null): string {
  if (!status) return "Sin dato";
  return PAYMENT_STATUS_LABEL[status as PaymentStatus] ?? status;
}

export function paymentStatusVariant(status: string | null): BadgeVariant {
  if (!status) return "neutral";
  return PAYMENT_STATUS_VARIANT[status as PaymentStatus] ?? "neutral";
}

/** An impaga sale whose due date has passed (`today` as "YYYY-MM-DD"). */
export function isOverdue(
  sale: { payment_status: string | null; due_date: string | null },
  today: string,
): boolean {
  return sale.payment_status === "impago" && Boolean(sale.due_date) && (sale.due_date as string) < today;
}

/** Credit notes carry no collection: they are never marked paid or unpaid. */
export function hasPaymentStatus(documentType: string): boolean {
  return documentType !== "credit_note";
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PaymentStatusChange =
  | { error: string }
  | { error: null; ids: string[]; status: PaymentStatus; paidAt: string | null };

/**
 * Reads the change a form asks for: the sales (`ids`, one or many), the new
 * status and an optional payment date (only kept for "pagado"; going back to
 * impaga always clears it).
 */
export function parsePaymentStatusChange(formData: FormData): PaymentStatusChange {
  const ids = Array.from(
    new Set(
      formData
        .getAll("ids")
        .filter((value): value is string => typeof value === "string" && UUID.test(value)),
    ),
  );
  const status = formData.get("status");
  const rawPaidAt = formData.get("paid_at");
  const paidAt = typeof rawPaidAt === "string" ? rawPaidAt.trim() : "";

  if (ids.length === 0) {
    return { error: "Seleccioná al menos una venta." };
  }
  if (!isPaymentStatus(status)) {
    return { error: "Elegí Pagada o Impaga." };
  }
  if (paidAt && !ISO_DATE.test(paidAt)) {
    return { error: "La fecha de pago no es válida." };
  }

  return { error: null, ids, status, paidAt: status === "pagado" && paidAt ? paidAt : null };
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
